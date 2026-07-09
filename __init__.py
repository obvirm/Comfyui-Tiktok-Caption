"""
Takumi Caption — ComfyUI Custom Node (tscaps engine)
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

logger = logging.getLogger("TakumiCaption")

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
  -webkit-text-stroke: 0.02em #000;
  paint-order: stroke fill;
  line-height: 1.3;
}
.line { display: block; text-align: center; white-space: normal; }
.line + .line { margin-top: 0.1em; }
.word { display: inline-block; margin: 0 0.14em; }
.word.word-being-narrated { color: var(--tscaps-highlight-color, #ffd400); }
.word.word-already-narrated { color: #e0e0e0; }
.quote { color: var(--tscaps-quote-color, #e6d647); font-style: italic; }"""

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


class TakumiCaptionNode:
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
                "font_size": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 100.0, "step": 0.5}),
                # Caption anchor inside the frame. Defaults match the engine's
                # DEFAULT_ALIGNMENT so existing renders are unchanged.
                "vertical_align": (["top", "center", "bottom"], {"default": "bottom"}),
                "vertical_offset": ("FLOAT", {"default": 0.85, "min": 0.0, "max": 1.0, "step": 0.01}),
                "horizontal_align": (["left", "center", "right"], {"default": "center"}),
                "horizontal_offset": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0, "step": 0.01}),
                "rotation": ("FLOAT", {"default": 0.0, "min": -180.0, "max": 180.0, "step": 1.0}),
                "text_color": ("STRING", {"default": "", "multiline": False}),
                "highlight_color": ("STRING", {"default": "", "multiline": False}),
                # template LAST so older workflows (srt,css,w,h) keep mapping
                "template": (template_names, {"default": "(none / custom)"}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "execute"
    CATEGORY = "image/text"

    def execute(self, srt, css, width, height, font_size, vertical_align,
                vertical_offset, horizontal_align, horizontal_offset,
                rotation, text_color, highlight_color, template):
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
        tc = (text_color or "").strip()
        if tc:
            inline_styles["--tscaps-primary-color"] = tc
        hc = (highlight_color or "").strip()
        if hc:
            inline_styles["--tscaps-highlight-color"] = hc
        alignment = {
            "verticalAlign": vertical_align,
            "verticalOffset": float(vertical_offset),
            "horizontalAlign": horizontal_align,
            "horizontalOffset": float(horizontal_offset),
        }
        return self._render(css, inline_styles, alignment, srt, width, height)

    def _render(self, css, inline_styles, alignment, srt, width, height):
        import torch, numpy as np
        from PIL import Image
        if render_frames is None:
            logger.error("render_frames unavailable")
            return (torch.zeros((1, height, width, 3), dtype=torch.float32),)
        try:
            pngs = render_frames(srt, css, width, height, inline_styles=inline_styles, alignment=alignment)
            if not pngs:
                logger.warning("No frames rendered")
                return (torch.zeros((1, height, width, 3), dtype=torch.float32),)
            n = len(pngs)
            buf = np.zeros((n, height, width, 3), dtype=np.float32)
            for i, png in enumerate(pngs):
                img = Image.open(io.BytesIO(png)).convert("RGB")
                arr = np.asarray(img, dtype=np.float32)
                buf[i] = arr / 255.0
            return (torch.from_numpy(buf),)
        except Exception as e:
            # ComfyUI's stderr is broken (OSError Errno 22); do NOT print
            # tracebacks to it or the process dies. Log quietly instead.
            try:
                logger.error(f"Caption render failed: {e}")
            except Exception:
                pass
            return (torch.zeros((1, height, width, 3), dtype=torch.float32),)


NODE_CLASS_MAPPINGS = {"TakumiCaptionNode": TakumiCaptionNode}
NODE_DISPLAY_NAME_MAPPINGS = {"TakumiCaptionNode": "Takumi Caption (tscaps)"}
__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
