"""Headless render child process.

ComfyUI's std fds are broken (OSError Errno 22 when written to), and that
broken state is inherited by any subprocess → Playwright's chromium spawn
fails. To avoid inheriting them entirely, this child is spawned with
stdin/stdout/stderr = DEVNULL and communicates via temp FILES:
  env RENDER_REQ  = path to JSON request  {params, fps}
  env RENDER_OUT  = path to write JSON result (array of data URLs or {"error"})
"""
import sys, os, json, base64, traceback

ERR_LOG = "C:/tmp/render_child_err.log"
node_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for p in (os.path.join(node_root, "node_modules", ".bin"), node_root):
    if p not in os.environ.get("PATH", ""):
        os.environ["PATH"] = p + os.pathsep + os.environ.get("PATH", "")


def fail(msg):
    try:
        with open(ERR_LOG, "a", encoding="utf-8") as f:
            f.write(msg + "\n")
    except Exception:
        pass
    try:
        with open(os.environ.get("RENDER_OUT", "C:/tmp/render_out.json"), "w", encoding="utf-8") as f:
            json.dump({"error": msg}, f)
    except Exception:
        pass


def main():
    try:
        req_path = os.environ["RENDER_REQ"]
        out_path = os.environ["RENDER_OUT"]
        with open(req_path, "r", encoding="utf-8") as f:
            req = json.load(f)
        params = req["params"]
        fps = req.get("fps", 30)
        from cloakbrowser import launch
        browser = launch(headless=True)
        try:
            page = browser.new_page()
            try:
                page.goto("about:blank")
                js_path = os.path.join(node_root, "web", "js", "tiktok_caption.js")
                page.add_script_tag(path=js_path)
                out = page.evaluate(
                    "(a) => window.TikTokCaption.renderCaptionFrames(a.params, a.fps)",
                    {"params": params, "fps": fps},
                )
                with open(out_path, "w", encoding="utf-8") as f:
                    json.dump(out, f)
            finally:
                page.close()
        finally:
            browser.close()
    except Exception as e:
        fail(f"{type(e).__name__}: {e}\n{traceback.format_exc()}")


if __name__ == "__main__":
    main()
