// Takumi Caption (tscaps) — in-node live preview
// Preview renders caption frames directly in the user's browser using the
// same tscaps engine that the headless final renderer uses → 1:1 output.
// Build: npx esbuild src/takumi_caption.ts --bundle --minify --alias:@modules=./vendor/tscaps-engine/modules --outfile=web/js/takumi_caption.js

import { renderCaptionFramesToBitmaps, SAMPLE_FPS } from './caption_render';

const TAG = '[Takumi]';

function domEl(node: any): HTMLElement | null {
  if (node.graphcanvas?.node_dom) {
    const nd = node.graphcanvas.node_dom;
    let el = nd instanceof Map ? nd.get(node.id) : nd[node.id];
    if (!el && typeof nd === 'object')
      for (const k in nd) { if (String(k) === String(node.id)) { el = nd[k]; break; } }
    return el ?? null;
  }
  const cv = (window as any).comfyAPI?.app?.app?.canvas || (window as any).app?.canvas;
  if (cv?.node_dom) {
    const el = cv.node_dom instanceof Map ? cv.node_dom.get(node.id) : cv.node_dom[node.id];
    if (el) node.graphcanvas = cv;
    return el ?? null;
  }
  for (const vn of document.querySelectorAll('[class*="group/node"]')) {
    if (vn.textContent?.includes('Takumi Caption')) return vn as HTMLElement;
  }
  return null;
}

function getWidgetVal(node: any, name: string): any {
  return node.widgets?.find((w: any) => w.name === name)?.value;
}

function setupWidget(node: any): void {
  if (node.__tw) return;
  node.__tw = true;

  let frameTimer: ReturnType<typeof setInterval> | null = null;
  let frameBitmaps: ImageBitmap[] = [];
  // Serialize renders: never let two render() runs overlap (overlap = one
  // cleanup() closing the other's bitmaps mid-draw = flicker). If a change
  // arrives while rendering, mark dirty and re-run once it finishes.
  let rendering = false;
  let dirty = false;

  function cleanup() {
    if (frameTimer) { clearInterval(frameTimer); frameTimer = null; }
    frameBitmaps.forEach(b => { try { b.close(); } catch {} });
    frameBitmaps = [];
  }

  const wrap = document.createElement('div');
  wrap.style.cssText = 'width:100%;display:flex;flex-direction:column';
  wrap.className = 'takumi-preview-widget';

  const row = document.createElement('div');
  row.style.cssText = 'width:100%;display:flex;align-items:center;gap:8px;margin-top:16px';
  const lbl = document.createElement('span');
  lbl.style.cssText = 'color:#999;font-size:11px;white-space:nowrap';
  lbl.textContent = 'Preview:';
  row.appendChild(lbl);

  const c = document.createElement('div');
  // Container fills the node width; its aspect ratio is set at render time to
  // match the OUTPUT (width:height) so the caption is never distorted.
  c.style.cssText = 'width:100%;box-sizing:border-box;background:#000;position:relative;overflow:hidden;border-radius:4px;border:2px solid #444';
  // On first layout, adopt the output aspect ratio so the box isn't squashed
  // before the first render() runs.
  c.style.aspectRatio = '9 / 16';

  const canvas = document.createElement('canvas');
  // No object-fit here: we size the backing store to the *displayed* device
  // pixels and draw the frame 1:1, so the browser never upscales the canvas
  // (which was the cause of the blurry preview).
  canvas.style.cssText = 'display:block;width:100%;height:100%;background:#000';
  c.appendChild(canvas);
  const ctx = canvas.getContext('2d');

  const st = document.createElement('span');
  st.style.cssText = 'position:absolute;bottom:4px;left:4px;color:#aaa;font-size:10px;font-family:monospace;background:rgba(0,0,0,0.7);padding:1px 5px;border-radius:3px;pointer-events:none;z-index:1';
  c.appendChild(st);

  wrap.appendChild(row);
  wrap.appendChild(c);

  async function render() {
    // If a render is already in flight, just mark dirty and let it re-run
    // when done (prevents overlapping renders → flicker).
    if (rendering) { dirty = true; return; }
    rendering = true;
    cleanup();
    const srt = getWidgetVal(node, 'srt') || '';
    const width = parseInt(getWidgetVal(node, 'width') || '540');
    const height = parseInt(getWidgetVal(node, 'height') || '960');
    if (!srt.trim()) { st.textContent = 'no srt'; return; }
    // Match the preview box aspect ratio to the OUTPUT aspect ratio so the
    // caption is never distorted when output isn't 9/16.
    if (height > 0) c.style.aspectRatio = `${width} / ${height}`;
    // --- PROXY PREVIEW ---
    // We render the caption at the OUTPUT's real resolution (so the engine's
    // `cqh`-based font sizing computes the caption at the true size), then let
    // CSS shrink the whole canvas into the small preview box. The result is a
    // ZOOM of the real frame — the text and frame scale together uniformly,
    // the caption does NOT re-layout / change proportions. That is exactly
    // the "proxy" behaviour you want: change the output resolution and the
    // preview just zooms, the caption looks identical relative to the frame.
    // We cap the preview's long edge at PROXY_LONG so a 4K output can't OOM
    // the browser with a giant canvas; the cap scales the proxy down
    // UNIFORMLY, so the text-to-frame ratio (and thus the zoom look) is
    // preserved 1:1 with the real output.
    const PROXY_LONG = 1280;
    const scale = Math.min(1, PROXY_LONG / Math.max(width, height));
    const pw = Math.max(64, Math.round(width * scale));
    const ph = Math.max(64, Math.round(height * scale));
    canvas.width = pw;
    canvas.height = ph;

    let css = getWidgetVal(node, 'css') || '';
    let inline: Record<string,string> = {};
    const template = getWidgetVal(node, 'template');
    if (template && template !== '(none / custom)') {
      try {
        const [cssTxt, jsonTxt] = await Promise.all([
          fetch(`/extensions/Comfyui-Caption-Live/templates/${template}/style.css`).then(r => r.text()),
          fetch(`/extensions/Comfyui-Caption-Live/templates/${template}/template.json`).then(r => r.text()),
        ]);
        css = cssTxt;
        const data = JSON.parse(jsonTxt);
        inline = varsFromTemplate(data);
      } catch (e: any) {
        st.textContent = 'tpl err: ' + (e?.message || e);
      }
    }
    st.textContent = 'rendering…';
    try {
      // Fast path: render straight to ImageBitmaps (no toDataURL/fetch/decode,
      // which was the cause of both flicker AND the "lemot" lag on every
      // parameter change). Bitmaps are cached and drawn 1:1 to the canvas.
      const bitmaps = await renderCaptionFramesToBitmaps({ srt, css, width: pw, height: ph, inlineStyles: inline });
      st.textContent = `${bitmaps.length} frames`;
      frameBitmaps = bitmaps;
      if (bitmaps.length === 0) return;
      const drawFrame = (b: ImageBitmap | null) => {
        if (!b || !ctx) return;
        // Clear fully first so a partially-transparent glyph/antialias from a
        // previous frame can't ghost behind the current one (the "berbayang"
        // double-image you saw). Then paint the new bitmap at 1:1.
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(b, 0, 0, canvas.width, canvas.height);
      };
      drawFrame(bitmaps[0]);
      if (bitmaps.length === 1) return;
      let fi = 0;
      frameTimer = setInterval(() => {
        fi = (fi + 1) % bitmaps.length;
        drawFrame(bitmaps[fi]);
      }, 1000 / SAMPLE_FPS);
    } catch (e: any) {
      st.textContent = 'err: ' + (e?.message || e);
      console.error(TAG, e);
    } finally {
      rendering = false;
      if (dirty) { dirty = false; render(); }
    }
  }

  /** Map a tscaps template.json to the --tscaps-* inline CSS variables. */
  function varsFromTemplate(data: any): Record<string,string> {
    const v: Record<string,string> = {};
    const typ = data?.typography || {};
    const ctl = data?.styleControls || [];
    const idMap: Record<string,string> = {
      'primary-color':'--tscaps-primary-color','highlight-color':'--tscaps-highlight-color',
      'shadow-color':'--tscaps-shadow-color','outline-color':'--tscaps-outline-color',
      'quote-color':'--tscaps-quote-color','chroma-a':'--tscaps-chroma-a','chroma-b':'--tscaps-chroma-b',
      'font-size':'--tscaps-font-size','font-family':'--tscaps-font-family','font-weight':'--tscaps-font-weight',
      'letter-spacing':'--tscaps-letter-spacing','word-spacing':'--tscaps-word-spacing',
      'line-spacing':'--tscaps-line-spacing','rotation':'--tscaps-rotation','text-align':'--tscaps-text-align',
      'text-case':'--tscaps-text-transform',
    };
    if (typ.fontFamily) v['--tscaps-font-family'] = typ.fontFamily;
    if (typ.fontWeight != null) v['--tscaps-font-weight'] = String(typ.fontWeight);
    if (typ.italic) v['--tscaps-font-style'] = 'italic';
    if (typ.fontSize != null) v['--tscaps-font-size'] = `${typ.fontSize * 3.5}cqh`;
    if (typ.letterSpacing != null) v['--tscaps-letter-spacing'] = `${typ.letterSpacing}em`;
    if (typ.wordSpacing != null) v['--tscaps-word-spacing'] = `${typ.wordSpacing}em`;
    if (typ.lineSpacing != null) v['--tscaps-line-spacing'] = `${typ.lineSpacing}em`;
    if (typ.textCase) v['--tscaps-text-transform'] = typ.textCase;
    if (typ.textAlign) v['--tscaps-text-align'] = typ.textAlign;
    if (typ.textDecoration) v['--tscaps-text-decoration'] = typ.textDecoration;
    if (typ.rotation != null) v['--tscaps-rotation'] = `${typ.rotation}deg`;
    for (const c of ctl) {
      if (c.id && idMap[c.id] && c.default != null) {
        let val = String(c.default);
        if (c.id === 'font-size') val = `${parseFloat(val) * 3.5}cqh`;
        else if (c.id === 'letter-spacing' || c.id === 'word-spacing' || c.id === 'line-spacing') val = `${val}em`;
        else if (c.id === 'rotation') val = `${val}deg`;
        v[idMap[c.id]] = val;
      }
    }
    return v;
  }

  let attempts = 0;
  const poll = setInterval(() => {
    attempts++;
    const el = domEl(node);
    if (el) {
      clearInterval(poll);
      if (el.querySelector('.takumi-preview-widget')) return;
      el.style.overflow = 'hidden';
      el.appendChild(wrap);
      wrap.style.gridColumn = '1 / -1';
      wrap.style.gridRow = '-1';
      wrap.style.order = '9999';
      if (node.widgets) {
        node.widgets.forEach((w: any) => {
          const oc = w.callback;
          w.callback = function (this: any) {
            // Debounce: parameter drags fire many callbacks; collapse them
            // into one re-render per animation frame so the preview stays
            // responsive (no "lemot" pile-up of concurrent renders).
            if (oc) oc.apply(this, arguments);
            if (!node.__twRaf) {
              node.__twRaf = true;
              requestAnimationFrame(() => { node.__twRaf = false; render(); });
            }
          };
        });
      }
      el.addEventListener('change', render, true);
      // Force an initial render slightly later (widget values may not be
      // populated synchronously at node-creation time)
      setTimeout(render, 500);
      render();
      return;
    }
    if (attempts > 150) clearInterval(poll);
  }, 200);
}

function waitForApp() {
  if ((window as any).LiteGraph?.LGraphNode) {
    const orig = (window as any).LiteGraph.LGraphNode.prototype.onNodeCreated;
    (window as any).LiteGraph.LGraphNode.prototype.onNodeCreated = function (this: any) {
      if (orig) orig.apply(this, arguments);
      setTimeout(() => {
        if (this.type === 'TakumiCaptionNode' || this.comfyClass === 'TakumiCaptionNode') {
          console.log(TAG, 'node', this.id);
          setupWidget(this);
        }
      }, 1000);
      return this;
    };
    console.log(TAG, 'active');
  } else {
    setTimeout(waitForApp, 500);
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', waitForApp);
else waitForApp();
