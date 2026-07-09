"""
Takumi Caption — headless caption renderer (CloakBrowser / Chromium).

Renders CSS-styled captions from SRT using the EXACT same tscaps engine
the in-node preview uses, so preview === output (1:1).

ComfyUI's std fds are broken (OSError Errno 22 on writes), and that broken
state is inherited by any subprocess, which makes Playwright's chromium
spawn fail. To fully avoid inheriting them, the actual browser render is
delegated to a clean child process (py/_render_child.py) spawned with
stdin/stdout/stderr = DEVNULL, communicating via temp files.
"""
import os, sys, json, base64, subprocess, tempfile, logging

logger = logging.getLogger("TakumiCaption")

current_dir = os.path.dirname(__file__)
node_root = os.path.dirname(current_dir)
CHILD_SCRIPT = os.path.join(current_dir, "_render_child.py")
PY_EXE = sys.executable
TMP = "C:/tmp"


def render_frames(srt: str, css: str, width: int, height: int, inline_styles: dict = None, alignment: dict = None) -> list:
    """Render all caption frames → list of PNG bytes (same engine as preview).

    The fps parameter has been removed: the engine always samples at the
    fixed internal rate (SAMPLE_FPS = 30 in the JS bundle) so the headless
    final render is pixel-identical (1:1) to the in-node preview.
    """
    req_path = os.path.join(TMP, "render_req.json")
    out_path = os.path.join(TMP, "render_out.json")
    params = {
        "srt": srt, "css": css, "width": width, "height": height,
        "inlineStyles": inline_styles or {},
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
