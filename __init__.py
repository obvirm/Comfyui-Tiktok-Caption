"""
TikTok Caption — ComfyUI Custom Node (tscaps engine)
================================================================
Architecture (1:1 preview === output):
  • Preview   : runs in the user's browser (ComfyUI frontend). The
                frontend bundle calls the SAME tscaps engine to render
                caption frames live inside the node.
  • Final out : runs headless via CloakBrowser (Chromium) using the
                EXACT same tscaps engine + vendored source → identical
                pixels. No Whisper, no transcription: input is SRT/JSON.

No Node.js / Chrome runtime is required from the END USER. The frontend
JS is served by ComfyUI; the headless render uses the bundled Chromium
that `cloakbrowser` downloads once at install time.
"""
import os, sys, logging, io

logger = logging.getLogger("TikTokCaption")

current_dir = os.path.dirname(__file__)
# current_dir IS .../Comfyui-Caption-Live — that is the node root.
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

# Alias for readability in headless_render
node_root = current_dir

WEB_DIRECTORY = "web"

DEFAULT_CSS = """.segment{
  font-family: var(--tscaps-font-family, 'Montserrat'), system-ui, sans-serif;
  font-weight: 800;
  font-style: var(--tscaps-font-style, normal);
  /* cqh = proportional to FRAME height. So when you change the output
     resolution, the caption ZOOMS together with the frame (text grows/shrinks
     with the frame), it does NOT re-grow relative to the preview box. This is
     exactly the "proxy" look you want: the preview is just a zoomed-to-fit
     view of the real frame. The preview canvas is rendered at the output
     resolution and CSS-scaled down to the box (see takumi_caption.ts). */
  font-size: var(--tscaps-font-size, 13cqh);
  letter-spacing: var(--tscaps-letter-spacing, 0em);
  text-align: center;
  text-transform: none;
  text-decoration: none;
  color: var(--tscaps-primary-color, #ffffff);
  -webkit-text-stroke: var(--tscaps-outline-width, 0.02em) var(--tscaps-outline-color, #000);
  paint-order: stroke fill;
  text-shadow: var(--tscaps-outline-shadow, none);
  line-height: 1.3;
}
.line { display: block; text-align: center; white-space: normal; }
.line + .line { margin-top: 0.1em; }
.word { display: inline-block; margin: 0 0.14em; }
.word.word-being-narrated { color: var(--tscaps-highlight-color, #ffd400); }
.word.word-already-narrated { color: #e0e0e0; }
.quote { color: var(--tscaps-quote-color, #e6d647); font-style: italic; }
/* split_words_into_letters: per-letter spans for staggered animations */
.letter { display: inline-block; }"""

DEFAULT_SRT = """1
00:00:00,000 --> 00:00:02,000
WAH GILA BANGET!

2
00:00:02,000 --> 00:00:04,000
RENDER PAKAI TSCAPS"""

try:
    from py.headless_render import render_frames
    from py import templates as template_loader
    logger.info("Headless caption renderer imported")
except Exception as e:
    logger.error(f"Headless renderer import failed: {e}")
    render_frames = None
    template_loader = None

# ── Font CSS proxy ─────────────────────────────────────────────────────
# Served same-origin (under /api/) so the in-node preview can load a custom
# Google Font even when a reverse proxy in front of ComfyUI blocks the
# browser's direct CORS fetch to fonts.googleapis.com. The server fetches the
# @font-face CSS and inlines each font file as a data: URI (no extra browser
# fetch, no CORS), exactly like the headless final render does.
try:
    from aiohttp import web
    from server import PromptServer

    @PromptServer.instance.routes.get("/api/caption/font-css")
    async def _caption_font_css(request):
        family = (request.query.get("family", "") or "").strip()
        if not family:
            return web.Response(text="", content_type="text/css")
        try:
            from py.headless_render import _build_google_font_css
            css = _build_google_font_css(family)
        except Exception as e:
            logger.warning(f"Font CSS proxy failed for '{family}': {e}")
            css = ""
        return web.Response(
            text=css,
            content_type="text/css",
            headers={"Cache-Control": "public, max-age=86400"},
        )
    logger.info("Caption font-css proxy registered at /api/caption/font-css")
except Exception as e:
    logger.warning(f"Caption font-css proxy route not registered: {e}")


class TikTokCaptionNode:
    @classmethod
    def INPUT_TYPES(cls):
        template_names = ["(none / custom)"] + template_loader.list_templates()
        return {
            "required": {
                "srt": ("STRING", {"multiline": True, "default": DEFAULT_SRT}),
                "css": ("STRING", {"multiline": True, "default": DEFAULT_CSS}),
                # width/height min lowered to 1 so a stale positional mapping
                # (old template slot -> these) with value 0 self-heals to default.
                "width": ("INT", {"default": 540, "min": 1, "max": 4096}),
                "height": ("INT", {"default": 960, "min": 1, "max": 4096}),
                # font_size in cqh (% of frame height). 0 = use template/CSS default.
                "font_size": ("FLOAT", {"default": 4.0, "min": 0.0, "max": 100.0, "step": 0.5}),
                # Caption anchor inside the frame. Defaults match the engine's
                # DEFAULT_ALIGNMENT so existing renders are unchanged.
                "vertical_align": (["top", "center", "bottom"], {"default": "bottom"}),
                "vertical_offset": ("FLOAT", {"default": 0.85, "min": 0.0, "max": 1.0, "step": 0.01}),
                "horizontal_align": (["left", "center", "right"], {"default": "center"}),
                "horizontal_offset": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01}),
                "rotation": ("FLOAT", {"default": 0.0, "min": -180.0, "max": 180.0, "step": 1.0}),
                "text_color": ("STRING", {"default": "", "multiline": False}),
                "highlight_color": ("STRING", {"default": "", "multiline": False}),
                # Split each word into per-letter <span> elements for
                # letter-level CSS animations (wave, typewriter, bounce).
                "split_words_into_letters": ("BOOLEAN", {"default": False}),
                # Text case transform. Applied via CSS text-transform.
                "text_case": (["none", "lowercase", "capitalize", "uppercase"], {"default": "none"}),
                # Max words per caption segment. Controls caption density.
                "max_words": ("INT", {"default": 12, "min": 1, "max": 50, "step": 1}),
                # Max lines per segment. 1 = TikTok single-line, 2 = balanced, 3 = long.
                "max_lines": ("INT", {"default": 2, "min": 1, "max": 5, "step": 1}),
                # Gap-free: extend segment end time to eliminate flicker between captions.
                "gap_free": ("BOOLEAN", {"default": False}),
                # Font family dropdown. Overrides the template's default font.
                "font_family": ([
                    "(template default)", "Anton", "Bebas Neue", "Bungee",
                    "Bricolage Grotesque Variable", "Caveat Variable",
                    "Inter Variable", "JetBrains Mono Variable",
                    "Lora Variable", "Montserrat", "Noto Sans",
                    "Playfair Display Variable", "Roboto", "Rubik",
                    "Space Grotesque Variable", "Work Sans Variable",
                ], {"default": "(template default)"}),
                # Outline (text stroke) width in em. 0 = no outline.
                "outline": ("FLOAT", {"default": 0.02, "min": 0.0, "max": 0.5, "step": 0.01}),
                # Outline (text stroke) color. Empty = use CSS/template default (#000).
                "outline_color": ("STRING", {"default": "", "multiline": False}),
                # Outline corner style: flat (centered stroke), rounded (soft
                # halo), sharp (hard pointed / lancip outline via text-shadow).
                "outline_style": (["flat", "rounded", "sharp"], {"default": "flat"}),
                # template LAST so older workflows (srt,css,w,h) keep mapping
                "template": (template_names, {"default": "(none / custom)"}),
            },
            # Preview-only reference background image. Used by the in-node
            # preview to composite the caption over an image for placement
            # reference. NEVER baked into the exported frames (those stay
            # transparent, see RETURN_TYPES IMAGE + MASK).
            "optional": {
                "preview_image": ("IMAGE",),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    FUNCTION = "execute"
    CATEGORY = "image/text"

    def execute(self, srt, css, width, height, font_size, vertical_align,
                vertical_offset, horizontal_align, horizontal_offset,
                rotation, text_color, highlight_color, split_words_into_letters,
                text_case, max_words, max_lines, gap_free, font_family,
                outline, outline_color, outline_style, template, preview_image=None):
        import torch, numpy as np
        from PIL import Image
        # Self-heal stale/positional-mismatched numeric inputs.
        try:
            width = int(round(width)) if width else 540
        except Exception:
            width = 540
        try:
            height = int(round(height)) if height else 960
        except Exception:
            height = 960
        width = max(1, width)
        height = max(1, height)
        # Fixed internal sample rate (SAMPLE_FPS=30) is applied inside the
        # engine; no fps parameter is exposed (avoids preview/output desync
        # and the flicker that came from mismatched frame counts).
        # Build inline styles; numeric/color overrides only apply when the
        # user sets them, so template/CSS defaults are preserved otherwise.
        inline_styles = {}
        if template and template != "(none / custom)":
            loaded = template_loader.load_template(template, font_scale=3.5)
            if loaded:
                css = loaded["css"]
                inline_styles = dict(loaded["inlineStyles"])
        try:
            fs = float(font_size)
        except Exception:
            fs = 0.0
        if fs and fs > 0:
            inline_styles["--tscaps-font-size"] = f"{fs}cqh"
        try:
            rot = float(rotation)
        except Exception:
            rot = 0.0
        if rot != 0:
            inline_styles["--tscaps-rotation"] = f"{rot}deg"
        tc = str(text_color or "").strip()
        if tc:
            inline_styles["--tscaps-primary-color"] = tc
        hc = str(highlight_color or "").strip()
        if hc:
            inline_styles["--tscaps-highlight-color"] = hc
        # Outline (text stroke): width in em, color. Both drive the
        # --tscaps-outline-* custom properties the CSS references.
        try:
            ow = float(outline)
        except Exception:
            ow = 0.02
        inline_styles["--tscaps-outline-width"] = f"{ow}em"
        oc = str(outline_color or "").strip()
        if oc:
            inline_styles["--tscaps-outline-color"] = oc
        # Font family: use the override if set, otherwise the template's
        # default font. Either way the font is embedded (in headless) /
        # inlined (in preview) as @font-face so it renders in the SVG context.
        ff = str(font_family or "").strip()
        from py.headless_render import _norm_font
        if ff and ff != "(template default)":
            norm = _norm_font(ff)
            inline_styles["--tscaps-font-family"] = f"'{norm}'"
            embed_font = norm
        else:
            # template_loader already put the template default into inlineStyles
            embed_font = _norm_font(inline_styles.get("--tscaps-font-family", "") or "")
        alignment = {
            "verticalAlign": vertical_align,
            "verticalOffset": float(vertical_offset),
            "horizontalAlign": horizontal_align,
            "horizontalOffset": float(horizontal_offset),
        }
        return self._render(css, inline_styles, alignment, srt, width, height,
                           split_words_into_letters, text_case, max_words, max_lines,
                           gap_free, embed_font, outline, outline_color, outline_style)

    def _render(self, css, inline_styles, alignment, srt, width, height,
                split_words_into_letters=False, text_case="none",
                max_words=12, max_lines=2, gap_free=False, font_family="",
                outline=0.02, outline_color="", outline_style="flat"):
        import torch, numpy as np
        from PIL import Image
        if render_frames is None:
            logger.error("render_frames unavailable")
            return (torch.zeros((1, height, width, 3), dtype=torch.float32),
                    torch.zeros((1, height, width), dtype=torch.float32))
        try:
            pngs = render_frames(srt, css, width, height, inline_styles=inline_styles,
                                alignment=alignment, split_words_into_letters=split_words_into_letters,
                                 text_case=text_case, max_words=max_words, max_lines=max_lines,
                                 gap_free=gap_free, outline=outline, outline_color=outline_color,
                                 font_family=font_family, outline_style=outline_style)
            if not pngs:
                logger.warning("No frames rendered")
                return (torch.zeros((1, height, width, 3), dtype=torch.float32),
                        torch.zeros((1, height, width), dtype=torch.float32))
            n = len(pngs)
            img_buf = np.zeros((n, height, width, 3), dtype=np.float32)
            mask_buf = np.zeros((n, height, width), dtype=np.float32)
            for i, png in enumerate(pngs):
                # Keep the alpha channel so the exported caption is transparent
                # (the preview shows an optional background image, but the
                # exported frames never include it). The IMAGE output carries
                # the caption RGB (transparent areas are black) and MASK carries
                # the alpha — composite the two for a clean transparent overlay.
                rgba = Image.open(io.BytesIO(png)).convert("RGBA")
                rgb = np.asarray(rgba.convert("RGB"), dtype=np.float32) / 255.0
                alpha = np.asarray(rgba.split()[-1], dtype=np.float32) / 255.0
                img_buf[i] = rgb
                mask_buf[i] = alpha
            return (torch.from_numpy(img_buf), torch.from_numpy(mask_buf))
        except Exception as e:
            # ComfyUI's stderr is broken (OSError Errno 22); do NOT print
            # tracebacks to it or the process dies. Log quietly instead.
            try:
                logger.error(f"Caption render failed: {e}")
            except Exception:
                pass
            return (torch.zeros((1, height, width, 3), dtype=torch.float32),
                    torch.zeros((1, height, width), dtype=torch.float32))

NODE_CLASS_MAPPINGS = {"TikTokCaptionNode": TikTokCaptionNode}
NODE_DISPLAY_NAME_MAPPINGS = {"TikTokCaptionNode": "TikTok Caption (tscaps)"}
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
