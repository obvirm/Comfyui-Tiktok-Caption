"""
TikTok Caption — headless caption renderer (CloakBrowser / Chromium).

Renders CSS-styled captions from SRT using the EXACT same tscaps engine
the in-node preview uses, so preview === output (1:1).

ComfyUI's std fds are broken (OSError Errno 22 on writes), and that broken
state is inherited by any subprocess, which makes Playwright's chromium
spawn fail. To fully avoid inheriting them, the actual browser render is
delegated to a clean child process (py/_render_child.py) spawned with
stdin/stdout/stderr = DEVNULL, communicating via temp files.
"""
import os, sys, json, base64, subprocess, tempfile, logging, urllib.request, urllib.parse

logger = logging.getLogger("TikTokCaption")

current_dir = os.path.dirname(__file__)
node_root = os.path.dirname(current_dir)
CHILD_SCRIPT = os.path.join(current_dir, "_render_child.py")
PY_EXE = sys.executable
TMP = tempfile.gettempdir()

# Cache inlined @font-face CSS (with data: URIs) per font family so we only
# hit the network once per font, not on every render.
_FONT_CSS_CACHE: dict = {}

# Canonical Google Fonts family names differ from the "X Variable" names some
# templates use in CSS. Normalize before querying; also fix known mismatches.
_FONT_ALIASES = {"Space Grotesque": "Space Grotesk"}


def _norm_font(family: str) -> str:
    f = str(family or "").strip().strip("'\"")
    # Templates may reference e.g. 'Inter Variable'; the real Google family is
    # 'Inter' (the variable axis is implied). Strip the suffix for the query.
    if f.lower().endswith(" variable"):
        f = f[: -len(" variable")]
    return _FONT_ALIASES.get(f, f)


def _build_google_font_css(family: str) -> str:
    """Fetch Google Fonts @font-face CSS and inline each font file as a data: URI.

    Returns CSS ready to embed in the SVG (no further network fetch needed)."""
    family = _norm_font(family)
    if not family:
        return ""
    if family in _FONT_CSS_CACHE:
        return _FONT_CSS_CACHE[family]
    try:
        encoded = urllib.parse.quote(family)
        # A real browser UA is required so Google serves woff2 (not ttf).
        ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        # Variable fonts accept the weight-range axis; static-only fonts 400 on
        # it, so fall back to the plain request in that case.
        urls = [
            f"https://fonts.googleapis.com/css2?family={encoded}:wght@100..900&display=swap",
            f"https://fonts.googleapis.com/css2?family={encoded}&display=swap",
        ]
        css = ""
        last_err = None
        for url in urls:
            try:
                req = urllib.request.Request(url, headers={"User-Agent": ua})
                with urllib.request.urlopen(req, timeout=20) as resp:
                    css = resp.read().decode("utf-8")
                break
            except Exception as e:
                last_err = e
                continue
        if not css:
            raise last_err or RuntimeError("no CSS")
        # Inline every url() font file as a base64 data: URI.
        import re
        def _inline(m):
            u = m.group(1)
            if u.startswith("data:"):
                return m.group(0)
            try:
                fr = urllib.request.Request(u, headers={"User-Agent": ua})
                with urllib.request.urlopen(fr, timeout=20) as fr2:
                    data = fr2.read()
                b64 = base64.b64encode(data).decode("ascii")
                mime = "font/woff2" if u.endswith(".woff2") else ("font/woff" if u.endswith(".woff") else "application/octet-stream")
                return f"url(data:{mime};base64,{b64})"
            except Exception:
                return m.group(0)
        css = re.sub(r"url\(\s*['\"]?(.*?)['\"]?\s*\)", _inline, css)
        _FONT_CSS_CACHE[family] = css
        return css
    except Exception as e:
        logger.warning(f"Failed to fetch Google Fonts CSS for '{family}': {e}")
        return ""


# Local font files shipped with the node (not on Google Fonts). Map the exact
# family name the template stores in CSS → a same-origin URL we can embed.
_LOCAL_FONTS = {
    "Komika Axis": "/extensions/Comfyui-Caption-Live/fonts/komika-axis.woff2",
}


def _build_local_font_css(family: str) -> str:
    """Embed a same-origin woff2 as a base64 data: URI @font-face."""
    url = _LOCAL_FONTS.get(family)
    if not url:
        return ""
    try:
        # Resolve the same-origin URL to a local file path under the node.
        if url.startswith("/extensions/Comfyui-Caption-Live/"):
            rel = url[len("/extensions/Comfyui-Caption-Live/"):].lstrip("/")
            # The extension serves WEB_DIRECTORY ("web") at this root, so the
            # URL path is relative to the node root's web/ folder.
            path = os.path.join(node_root, "web", rel)
            if not os.path.isfile(path):
                path = os.path.join(node_root, rel)
        elif os.path.isabs(url):
            path = url
        else:
            path = os.path.join(node_root, "web", url)
        if not os.path.isfile(path):
            return ""
        with open(path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("ascii")
        return (
            "@font-face{font-family:'%s';src:url(data:font/woff2;base64,%s) "
            "format('woff2');font-weight:normal;font-style:normal;font-display:swap;}"
            % (family, b64)
        )
    except Exception as e:
        logger.warning(f"Failed to embed local font '{family}': {e}")
        return ""


def _build_font_css(family: str) -> str:
    """Return embeddable @font-face CSS for a family: local first, else Google."""
    if family in _LOCAL_FONTS:
        local = _build_local_font_css(family)
        if local:
            return local
    return _build_google_font_css(family)


def render_frames(srt: str, css: str, width: int, height: int, inline_styles: dict = None,
                   alignment: dict = None, split_words_into_letters: bool = False,
                   text_case: str = "none", layout: dict = None,
                    gap_free: bool = False, outline: float = 0.02, outline_color: str = "",
                    font_family: str = "", outline_style: str = "flat") -> list:
    """Render all caption frames → list of PNG bytes (same engine as preview).

    The fps parameter has been removed: the engine always samples at the
    fixed internal rate (SAMPLE_FPS = 30 in the JS bundle) so the headless
    final render is pixel-identical (1:1) to the in-node preview.
    """
    req_path = os.path.join(TMP, "render_req.json")
    out_path = os.path.join(TMP, "render_out.json")
    # Pre-inline the chosen font's @font-face CSS (data: URIs) so the SVG
    # foreignObject context has the font available. Cached per family.
    font_css = ""
    ff = str(font_family or "").strip()
    if ff and ff != "(template default)":
        font_css = _build_font_css(ff)
    params = {
        "srt": srt, "css": css, "width": width, "height": height,
        "inlineStyles": inline_styles or {},
        "splitWordsIntoLetters": split_words_into_letters,
        "textCase": text_case,
        "layout": layout,
        "gapFree": gap_free,
        "outline": outline,
        "outlineColor": outline_color,
        "outlineStyle": outline_style,
        "fontCss": font_css,
    }
    if alignment:
        params["alignment"] = alignment
    req = {
        "params": params,
        # fps kept in payload for backward-compat with the child but ignored
        # (the JS uses its internal SAMPLE_FPS constant).
        "fps": 30,
    }
    with open(req_path, "w", encoding="utf-8") as f:
        json.dump(req, f)
    # Ensure stale output removed
    if os.path.exists(out_path):
        os.remove(out_path)
    env = dict(os.environ)
    env["PYTHONPATH"] = node_root + os.pathsep + env.get("PYTHONPATH", "")
    env["RENDER_REQ"] = req_path
    env["RENDER_OUT"] = out_path
    try:
        subprocess.run(
            [PY_EXE, CHILD_SCRIPT],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, env=env, timeout=180,
        )
    except subprocess.TimeoutExpired:
        logger.error("Render child timed out")
        return []
    if not os.path.exists(out_path):
        logger.error("Render child produced no output file")
        return []
    try:
        with open(out_path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        logger.error(f"Failed to read render output: {e}")
        return []
    if isinstance(data, dict) and "error" in data:
        logger.error(f"Render child error: {data['error']}")
        return []
    frames = []
    for du in data:
        if du and du.startswith("data:image/png;base64,"):
            frames.append(base64.b64decode(du.split(",", 1)[1]))
    return frames
