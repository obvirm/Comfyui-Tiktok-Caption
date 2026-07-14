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

# ── tscaps-native font catalog ──────────────────────────────────────────
# Mirrors vendored tscaps-ui/core/fonts/domain/FontCatalog.ts so the node's
# font picker offers exactly the same families tscaps ships. Values keep the
# "<Name> Variable" suffix the @font-face uses; _norm_font strips it for the
# Google Fonts query.
FONT_CATALOG = [
   "Inter Variable", "Poppins", "Montserrat Variable", "Roboto", "Anton",
    "Bebas Neue", "Bangers", "Komika Axis", "Manrope Variable",
    "Nunito Variable", "Raleway Variable", "DM Sans Variable",
    "Comfortaa Variable", "Bricolage Grotesque Variable", "Oswald Variable",
    "Bungee", "Righteous", "Playfair Display Variable", "EB Garamond Variable",
    "DM Serif Display", "Fraunces Variable", "Lora Variable",
    "Dancing Script Variable", "Pacifico", "Lobster", "Caveat Variable",
    "Permanent Marker", "JetBrains Mono Variable", "VT323", "Press Start 2P",
]
FONT_OPTIONS = ["(template default)"] + FONT_CATALOG

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
                # ── Transcript (only non-style input) ──
                "srt": ("STRING", {"multiline": True, "default": DEFAULT_SRT}),
                # ── Output frame ──
                "width": ("INT", {"default": 540, "min": 1, "max": 4096}),
                "height": ("INT", {"default": 960, "min": 1, "max": 4096}),
                # ── TYPOGRAPHY (tscaps TypographyConfig) ──
                # 0 / (auto) = leave the template/CSS default untouched.
                "font_family": (FONT_OPTIONS, {"default": "(template default)"}),
                "font_size": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100.0, "step": 0.5}),
                "font_weight": ("INT", {"default": 0, "min": 0, "max": 900, "step": 100}),
                "letter_spacing": ("FLOAT", {"default": 0.0, "min": -0.2, "max": 0.5, "step": 0.005}),
                "word_spacing": ("FLOAT", {"default": 0.0, "min": -0.5, "max": 1.0, "step": 0.01}),
                "line_spacing": ("FLOAT", {"default": 0.0, "min": -0.5, "max": 1.0, "step": 0.01}),
                "text_align": (["(auto)", "left", "center", "right"], {"default": "(auto)"}),
                "text_case": (["(auto)", "none", "uppercase", "lowercase"], {"default": "(auto)"}),
                "italic": (["(auto)", "on", "off"], {"default": "(auto)"}),
                "underline": (["(auto)", "on", "off"], {"default": "(auto)"}),
                "strikethrough": (["(auto)", "on", "off"], {"default": "(auto)"}),
                # ── POSITION (tscaps AlignmentConfig) ──
                "vertical_align": (["top", "center", "bottom"], {"default": "bottom"}),
                "vertical_offset": ("FLOAT", {"default": 0.85, "min": 0.0, "max": 1.0, "step": 0.01}),
                "horizontal_align": (["left", "center", "right"], {"default": "center"}),
                "horizontal_offset": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01}),
                # ── EFFECT (tscaps RotationConfig + colors + outline) ──
                "rotation": ("FLOAT", {"default": 0.0, "min": -180.0, "max": 180.0, "step": 1.0}),
                "text_color": ("STRING", {"default": "", "multiline": False}),
                "highlight_color": ("STRING", {"default": "", "multiline": False}),
                "outline": ("FLOAT", {"default": 0.02, "min": 0.0, "max": 0.5, "step": 0.01}),
                "outline_color": ("STRING", {"default": "", "multiline": False}),
                "outline_style": ("BOOLEAN", {"default": False, "label_on": "sharp", "label_off": "flat"}),
                # ── LAYOUT (tscaps Scenes + Lines splitters) ──
                "split_by_speaker": ("BOOLEAN", {"default": False}),
                "split_by": (["(auto)", "none", "sentence", "clause"], {"default": "(auto)"}),
                "max_letters": ("INT", {"default": 0, "min": 0, "max": 200, "step": 1}),
                "min_letters": ("INT", {"default": 0, "min": 0, "max": 200, "step": 1}),
                "lines_max": ("INT", {"default": 0, "min": 0, "max": 8, "step": 1}),
                "lines_min": ("INT", {"default": 0, "min": 0, "max": 8, "step": 1}),
                "max_line_width": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.05}),
                "gap_free": ("BOOLEAN", {"default": False}),
                # ── CODE (raw CSS override + template) ──
                "css": ("STRING", {"multiline": True, "default": DEFAULT_CSS}),
                # template LAST so positional inputs (srt,w,h) keep mapping
                "template": (template_names, {"default": "(none / custom)"}),
                # Per-template dynamic overrides (typography/alignment/effects/
                # styleControls) written by the sidebar Parameters panel as a
                # JSON map of control-id → value. Merged on top of the template
                # defaults at render time (like tscaps merges a sheet).
                "template_overrides": ("STRING", {"multiline": True, "default": "{}"}),            },
            # Preview-only reference background image (never baked into frames).
            "optional": {
                "preview_image": ("IMAGE",),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK")
    FUNCTION = "execute"
    CATEGORY = "image/text"

    def execute(self, srt, width, height, font_family, font_size, font_weight,
                letter_spacing, word_spacing, line_spacing, text_align, text_case,
                italic, underline, strikethrough, vertical_align, vertical_offset,
                horizontal_align, horizontal_offset, rotation, text_color,
                highlight_color, outline, outline_color, outline_style,
                split_by_speaker, split_by, max_letters, min_letters, lines_max,
                lines_min, max_line_width, gap_free, css, template,
                template_overrides, preview_image=None):
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
        # Build the inline-style map from the tscaps-native typography /
        # position / effect widgets. Only values the user explicitly changed
        # (non-zero / non-"(auto)") are emitted, so a selected template's own
        # defaults win otherwise — exactly like tscaps.
        inline_styles = {}
        if template and template != "(none / custom)":
            loaded = template_loader.load_template(template, font_scale=3.5)
            if loaded:
                css = loaded["css"]
                inline_styles = dict(loaded["inlineStyles"])

        # ── Merge per-template dynamic overrides (from the sidebar Parameters
        # panel) on top of the template defaults. Supports typography keys
        # (fontFamily/size/weight/letterSpacing/wordSpacing/lineSpacing/
        # textAlign/textCase/italic/underline/strikethrough), alignment keys
        # (verticalAlign/verticalOffset/horizontalAlign/horizontalOffset),
        # effect toggles (effect:gap_free, effect:remove_punctuation, ...),
        # and any styleControls id (--tscaps-<id>). Mirrors tscaps merging a
        # sheet's style values over the template's own defaults.
        overrides = {}
        try:
            if template_overrides and str(template_overrides).strip() not in ("", "{}"):
                overrides = json.loads(str(template_overrides))
        except Exception:
            overrides = {}
        if overrides:
            from py import templates as _tplmod
            inline_styles.update(_tplmod.apply_overrides(overrides, css if 'css' in dir() else ""))
            # effect toggles also feed the engine transforms
            eff = {k.split(":", 1)[1]: v for k, v in overrides.items() if k.startswith("effect:")}
            if eff:
                globals()["_tscaps_effect_overrides"] = eff
        # font_family override from sidebar should win over template default
        from py.headless_render import _norm_font
        ff = str(font_family or "").strip()
        if ff and ff != "(template default)":
            norm = _norm_font(ff)
            inline_styles["--tscaps-font-family"] = f"'{norm}'"
            embed_font = norm
        else:
            embed_font = _norm_font(inline_styles.get("--tscaps-font-family", "") or "")
        # Static node typography widgets still act as a global override on top
        # of the template defaults + sidebar overrides (only when changed).
        try:
            fs = float(font_size)
        except Exception:
            fs = 0.0
        if fs and fs > 0:
            inline_styles["--tscaps-font-size"] = f"{fs}cqh"
        try:
            fw = int(font_weight)
        except Exception:
            fw = 0
        if fw and fw > 0:
            inline_styles["--tscaps-font-weight"] = str(fw)
        try:
            ls = float(letter_spacing)
        except Exception:
            ls = 0.0
        if ls and ls != 0.0:
            inline_styles["--tscaps-letter-spacing"] = f"{ls}em"
        try:
            ws = float(word_spacing)
        except Exception:
            ws = 0.0
        if ws and ws != 0.0:
            inline_styles["--tscaps-word-spacing"] = f"{ws}em"
        try:
            lns = float(line_spacing)
        except Exception:
            lns = 0.0
        if lns and lns != 0.0:
            inline_styles["--tscaps-line-spacing"] = f"{lns}em"
        if text_align and text_align != "(auto)":
            inline_styles["--tscaps-text-align"] = text_align
        if text_case and text_case != "(auto)":
            inline_styles["--tscaps-text-transform"] = text_case
        if italic and italic != "(auto)":
            inline_styles["--tscaps-font-style"] = "italic" if italic == "on" else "normal"
        decorations = []
        if underline == "on":
            decorations.append("underline")
        if strikethrough == "on":
            decorations.append("line-through")
        if decorations:
            inline_styles["--tscaps-text-decoration"] = " ".join(decorations)
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
        alignment = {
            "verticalAlign": vertical_align,
            "verticalOffset": float(vertical_offset),
            "horizontalAlign": horizontal_align,
            "horizontalOffset": float(horizontal_offset),
        }
        # Merge per-template alignment overrides (from the sidebar panel).
        if overrides:
            for k in ("verticalAlign", "verticalOffset", "horizontalAlign", "horizontalOffset"):
                if k in overrides:
                    alignment[k] = overrides[k]
        # Merge effect toggles into gap_free / layout where the engine supports.
        eff = {k.split(":", 1)[1]: v for k, v in overrides.items() if k.startswith("effect:")}
        if eff.get("gap_free"):
            gap_free = True
        # Build the tscaps-native Layout map from the Scenes/Lines widgets.
        layout = {}
        if split_by_speaker:
            layout['splitBySpeaker'] = True
        if split_by and split_by != '(auto)':
            layout['boundaryMode'] = split_by
        try:
            ml = int(max_letters)
        except Exception:
            ml = 0
        if ml and ml > 0:
            layout['maxLetters'] = ml
        try:
            mn = int(min_letters)
        except Exception:
            mn = 0
        if mn and mn > 0:
            layout['minLetters'] = mn
        try:
            lmax = int(lines_max)
        except Exception:
            lmax = 0
        if lmax and lmax > 0:
            layout['maxLines'] = lmax
        try:
            lmin = int(lines_min)
        except Exception:
            lmin = 0
        if lmin and lmin > 0:
            layout['minLines'] = lmin
        try:
            mlw = float(max_line_width)
        except Exception:
            mlw = 0.0
        if mlw and mlw > 0:
            layout['maxLineWidth'] = mlw
        return self._render(css, inline_styles, alignment, srt, width, height,
                           text_case if text_case != "(auto)" else "none",
                           layout, gap_free, embed_font, outline,
                           outline_color, outline_style)

    def _render(self, css, inline_styles, alignment, srt, width, height,
                text_case="none",
                layout=None, gap_free=False, font_family="",
                outline=0.02, outline_color="", outline_style="flat"):
        import torch, numpy as np
        from PIL import Image
        if render_frames is None:
            logger.error("render_frames unavailable")
            return (torch.zeros((1, height, width, 3), dtype=torch.float32),
                    torch.zeros((1, height, width), dtype=torch.float32))
        try:
            pngs = render_frames(srt, css, width, height, inline_styles=inline_styles,
                                alignment=alignment,
                                 text_case=text_case, layout=layout,
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
