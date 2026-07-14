# Project Memory

## Decisions

- ## Decisions
- 2026-07-06: FULL TAKUMI untuk semua. Preview pakai Takumi WASM (browser). Backend pakai Takumi PyO3/maturin (Python binding).
- 2026-07-06: BANNED - Satori, Canvas API, SVG text manual, takumi.exe (subprocess). Tidak boleh dipakai lagi.
- 2026-07-06: Target: Takumi WASM untuk preview, Takumi PyO3 (.pyd) untuk backend.
- ## Active Context
- Fokus: Build Takumi WASM untuk browser preview
- Fokus: Build Takumi PyO3 binding untuk Python backend
- Takumi source: takumi/ (cloned dari github.com/obvirm/takumi)
- Takumi Rust workspace: takumi-cli (binary), takumi-wasm (WASM), takumi-py (PyO3)
- WASM dependencies: wasm-bindgen, wasm-pack
- PyO3 dependencies: maturin, pyo3
- ## Bugs & Fixes
- 2026-07-06: Satori bundle gagal di browser - process is not defined, Buffer not found, yoga.wasm async load. Status: DITINGGALKAN, pakai Takumi WASM.
- 2026-07-06: Takumi WASM gagal load di Python - wasm-bindgen JS imports tidak tersedia. Status: BELUM SELESAI.
- 2026-07-06: Letter-spacing tidak berfungsi di Canvas mode. Status: DITINGGALKAN, pakai Takumi.
- ## Patterns
- ComfyUI custom node web extension: taruh .js di folder web/, ComfyUI serve sebagai static files di /extensions/{node_name}/
- App access: `window.comfyAPI.app.app` (bukan import dari /scripts/app.js)
- Takumi WASM bundle: wasm-pack build → pkg/ → JS bindings + WASM binary
- Takumi PyO3: maturin build → .pyd (Windows) / .so (Linux) → import langsung di Python
- 2026-07-07: Routes pakai @routes.post('/path') decorator, bukan routes.append(). PromptServer.routes = RouteTableDef.
- 2026-07-07: Routes pakai @routes.post('/path') decorator, bukan routes.append(). PromptServer.routes = RouteTableDef.
- 2026-07-08: Takumi Caption node — architecture finalized (2026-07-09):
- 2026-07-08: Engine: tscaps (francozanardi/tscaps) vendored into `vendor/tscaps-engine/modules` (only rendering/transcription/css/splitting/svg-filter/document — no Whisper/mediabunny).
- 2026-07-08: Preview: runs in user's browser (ComfyUI frontend). `web/js/takumi_caption.js` (esbuild bundle) calls `window.TakumiCaption.renderCaptionFrames` from `src/caption_render.ts`. SAME engine as output → 1:1.
- 2026-07-08: Final output: headless CloakBrowser (`py/headless_render.py`) calls the exact same `window.TakumiCaption` API → identical pixels. Not headless? No problem — output only renders when queue/webhook fires AND browser is open; preview doubles as output.
- 2026-07-08: Input: SRT OR plain text (plain text auto-converted to SRT, 2s/line). No transcription.
- 2026-07-08: Text size fix: DEFAULT_CSS font-size 14cqh (was 7cqh → looked tiny in preview). cqh = % of canvas height.
- 2026-07-08: Build: `npx esbuild src/takumi_caption.ts --bundle --minify --alias:@modules=./vendor/tscaps-engine/modules --outfile=web/js/takumi_caption.js`
- 2026-07-08: WHL = the Python custom-node package (ships web/js + vendor + py/headless_render.py). cloakbrowser is the only runtime dep for headless render.
- 2026-07-08: Key bug fixed: node_root was wrong (pointed to py/ instead of node root) → render_frames import failed. Now current_dir IS node root.
- 2026-07-08: Key bug fixed: 2nd execute call returned 1 frame → fresh page per call + goto(about:blank) instead of set_content.
- 2026-07-08: Memory bug: tensor stacking OOM'd at low disk → preallocate np.zeros((n,h,w,3)) buffer.

## Active Context

- ## Active Context
- Fokus: Debug Satori agar jalan di browser ComfyUI
- Masalah Satori: process is not defined, Buffer not found, yoga.wasm async load
- Satori source: satori/ (cloned dari github.com/vercel/satori)
- Satori dependencies: @shuding/opentype.js (font), yoga.wasm (layout), twrnc (tailwind)
- Error terakhir: `process is not defined` dan `Unexpected token '.'`

## Bugs & Fixes

- ## Bugs & Fixes
- 2026-07-06: Satori bundle gagal di browser - process is not defined, Buffer not found, yoga.wasm async load. Status: BELUM SELESAI, harus diperbaiki.
- 2026-07-06: Letter-spacing tidak berfungsi di Canvas mode. Status: SEMENTARA pakai Canvas, harus ganti Satori.
- 2026-07-08: ComfyUI v28+ (Vue frontend) gak support `app.registerExtension()` / `beforeRegisterNodeDef`. Fix: file JS di-load via WEB_DIRECTORY, pake LiteGraph hook langsung, gak perlu `import` statement.
- 2026-07-14: Fixed missing template fonts (gallery "spread" + loki/Komika Axis not loading): added src/font_loader.ts with ensureBundledFonts() that injects @font-face data:URIs for all 35 bundled tscaps families into <head> once (called from mountLiveCaption + mountTemplateSidebar). normFont() strips " Variable" suffix for Google query; the registered face is rewritten back to "X Variable" so template vars resolve. Local non-Google fonts (Komika Axis) served from web/fonts/komika-axis.woff2 (copied from vendor/tscaps-ui/styles/fonts) and embedded via buildLocalFontFace; headless path uses py/headless_render._build_local_font_css(). Template var font-family now quoted in py/templates.py. Forced reflow of .word font-family after document.fonts.ready so late-loading web fonts replace the system fallback. Commit ecb8aaf, tag v1.0.2.
- 2026-07-14: Known: other templates that use Google families still need network for first load (cached after). Only Komika Axis is fully offline (local file). If more templates show wrong font, check template.json typography.fontFamily is in BUNDLED_GALLERY_FONTS (font_loader.ts) — add if missing.

## Changelog


## Patterns

- ComfyUI custom node web extension: taruh .js di folder web/, ComfyUI serve sebagai static files di /extensions/{node_name}/
- App access: `window.comfyAPI.app.app` (bukan import dari /scripts/app.js)
- PromptServer.routes adalah RouteTableDef (decorator-based), bukan list. Pakai `@routes.post('/path')` bukan `routes.append()`
- Route registration harus di module-level __init__.py dengan threading.Timer retry sampai PromptServer.instance tersedia
- Takumi WASM bundle: wasm-pack build → pkg/ → JS bindings + WASM binary
- Takumi PyO3: maturin build → .pyd (Windows) / .so (Linux) → import langsung di Python
- Real-time preview: Frontend POST /takumi/render → Python render_with_stroke() → base64 PNG → tampilkan
- Architecture: ONE engine (Takumi PyO3) untuk preview DAN output. Tidak ada WASM.
- 2026-07-07: Routes pakai @routes.post('/path') decorator, bukan routes.append(). PromptServer.routes = RouteTableDef.
- 2026-07-07: Routes pakai @routes.post('/path') decorator, bukan routes.append(). PromptServer.routes = RouteTableDef.
