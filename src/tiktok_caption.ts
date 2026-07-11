// TikTok Caption (tscaps) — in-node live preview
// Preview renders caption frames directly in the user's browser using the
// same tscaps engine that the headless final renderer uses → 1:1 output.
// Build: npx esbuild src/tiktok_caption.ts --bundle --minify --alias:@modules=./vendor/tscaps-engine/modules --outfile=web/js/tiktok_caption.js

import { renderCaptionFramesToBitmaps, SAMPLE_FPS } from './caption_render';

const TAG = '[TikTok]';

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
    if (vn.textContent?.includes('TikTok Caption')) return vn as HTMLElement;
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
  wrap.className = 'tiktok-preview-widget';

  const row = document.createElement('div');
  row.style.cssText = 'width:100%;display:flex;align-items:center;gap:8px;margin-top:16px';
  const lbl = document.createElement('span');
  lbl.style.cssText = 'color:#999;font-size:11px;white-space:nowrap';
  lbl.textContent = 'Preview:';
  row.appendChild(lbl);

  const c = document.createElement('div');
  // The preview box size is set explicitly in px at render time (render())
  // to the EXACT output aspect ratio, so the frame can never be stretched.
  // margin:0 auto centers it inside the node; it is the empty "wadah".
  c.style.cssText = 'margin:0 auto;box-sizing:border-box;background:#000;position:relative;overflow:hidden;border-radius:4px;border:2px solid #444';
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
    // --- NATIVE PREVIEW ---
    // Render the caption at the EXACT output resolution (width x height) so
    // the preview is pixel-identical (1:1) to the headless final render. No
    // downscale / proxy: the engine's `cqh` font sizing runs at the true frame
    // size, and CSS only displays the finished canvas scaled to fit the box.
    const pw = Math.max(1, Math.round(width));
    const ph = Math.max(1, Math.round(height));
    canvas.width = pw;
    canvas.height = ph;
    // Size the preview box to the EXACT output aspect ratio using explicit
    // pixel dimensions (no aspect-ratio + min/max conflict) so the frame can
    // never look stretched/squished ("gepeng"), landscape or portrait.
    const MAX_BOX = 320;
    const ar = pw / ph;
    let bw: number, bh: number;
    if (ar >= 1) { bw = MAX_BOX; bh = Math.max(1, Math.round(MAX_BOX / ar)); }
    else { bh = MAX_BOX; bw = Math.max(1, Math.round(MAX_BOX * ar)); }
    c.style.aspectRatio = 'auto';
    c.style.width = bw + 'px';
    c.style.height = bh + 'px';

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
    // font_size (cqh). 0 = use template/CSS default; >0 overrides it.
    const font_size = parseFloat(getWidgetVal(node, 'font_size') || '0') || 0;
    if (font_size > 0) inline['--tscaps-font-size'] = `${font_size}cqh`;
    // rotation (deg). 0 = use template/CSS default; !=0 overrides it.
    const rotation = parseFloat(getWidgetVal(node, 'rotation') || '0') || 0;
    if (rotation !== 0) inline['--tscaps-rotation'] = `${rotation}deg`;
    // color overrides (hex). empty = use template/CSS default.
    const text_color = (getWidgetVal(node, 'text_color') || '').trim();
    if (text_color) inline['--tscaps-primary-color'] = text_color;
    const highlight_color = (getWidgetVal(node, 'highlight_color') || '').trim();
    if (highlight_color) inline['--tscaps-highlight-color'] = highlight_color;
    // alignment (caption anchor inside the frame).
    const alignment = {
      verticalAlign: getWidgetVal(node, 'vertical_align') || 'bottom',
      verticalOffset: parseFloat(getWidgetVal(node, 'vertical_offset') || '0.85') || 0.85,
      horizontalAlign: getWidgetVal(node, 'horizontal_align') || 'center',
      horizontalOffset: parseFloat(getWidgetVal(node, 'horizontal_offset') || '0.5') || 0.5,
    };
    // letter-level splitting for per-character CSS animations.
    const splitLetters = !!getWidgetVal(node, 'split_words_into_letters');
    // text case transform.
    const textCase = getWidgetVal(node, 'text_case') || 'none';
    // segment density controls.
    const maxChars = parseInt(getWidgetVal(node, 'max_chars') || '40') || 40;
    const maxLines = parseInt(getWidgetVal(node, 'max_lines') || '2') || 2;
    // gap-free: eliminate flicker between segments.
    const gapFree = !!getWidgetVal(node, 'gap_free');
    st.textContent = 'rendering…';
    try {
      // Fast path: render straight to ImageBitmaps (no toDataURL/fetch/decode,
      // which was the cause of both flicker AND the "lemot" lag on every
      // parameter change). Bitmaps are cached and drawn 1:1 to the canvas.
      const bitmaps = await renderCaptionFramesToBitmaps({
        srt, css, width: pw, height: ph, inlineStyles: inline, alignment,
        splitWordsIntoLetters: splitLetters, textCase, maxChars, maxLines, gapFree,
      });
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

  // Debounce re-render on widget changes so the preview stays responsive.
  function wireCallbacks() {
    if (!node.widgets) return;
    node.widgets.forEach((w: any) => {
      const oc = w.callback;
      w.callback = function (this: any) {
        if (oc) oc.apply(this, arguments);
        // When the template changes, re-sync the color pickers to that
        // template's default colors so the picker never silently overrides
        // the template's look.
        if (this && this.name === 'template') syncColorDefaults(node);
        if (!node.__twRaf) {
          node.__twRaf = true;
          requestAnimationFrame(() => { node.__twRaf = false; render(); });
        }
      };
    });
  }

  // Replace a STRING widget with ComfyUI's built-in "color" picker, keeping the
  // same name and position so its hex value still maps to the Python input.
  function replaceWithColorWidget(n: any, name: string, defaultHex: string): void {
    const idx = n.widgets?.findIndex((w: any) => w.name === name);
    if (idx == null || idx < 0) return;
    n.widgets.splice(idx, 1);
    const cw = (n as any).addWidget('color', name, defaultHex, () => {});
    n.widgets.splice(idx, 0, cw);
  }

  // Sync the color pickers' values to the active template's default colors
  // (or neutral defaults when no template). This keeps the override a no-op
  // until the user actually picks a different color.
  async function syncColorDefaults(n: any): Promise<void> {
    let pc = '#ffffff';
    let hc = '#ffd400';
    const template = getWidgetVal(n, 'template');
    if (template && template !== '(none / custom)') {
      try {
        const json = await fetch(`/extensions/Comfyui-Caption-Live/templates/${template}/template.json`).then(r => r.text());
        const data = JSON.parse(json);
        const controls = data.styleControls || [];
        const pcCtl = controls.find((c: any) => c.id === 'primary-color');
        if (pcCtl && pcCtl.default) pc = pcCtl.default;
        const hcCtl = controls.find((c: any) => c.id === 'highlight-color');
        if (hcCtl && hcCtl.default) hc = hcCtl.default;
      } catch {}
    }
    const tw = n.widgets?.find((w: any) => w.name === 'text_color');
    if (tw) tw.value = pc;
    const hw = n.widgets?.find((w: any) => w.name === 'highlight_color');
    if (hw) hw.value = hc;
  }

  // Replace the text_color / highlight_color text boxes with ComfyUI's
  // built-in color pickers, synced to the active template's default colors.
  if (!node.__twColor && typeof (node as any).addWidget === 'function') {
    node.__twColor = true;
    try {
      replaceWithColorWidget(node, 'text_color', '#ffffff');
      replaceWithColorWidget(node, 'highlight_color', '#ffd400');
      syncColorDefaults(node);
    } catch (e) {
      node.__twColor = false;
      console.error('[TikTok] color picker setup failed:', e);
    }
  }

  // Register the preview as a ComfyUI DOM widget so the node EXTENDS DOWNWARD
  // to contain it (like an embedded iframe) instead of floating/overlapping
  // the widgets. ComfyUI manages its layout and grows the node height to fit.
  function mountPreview() {
    if (typeof (node as any).addDOMWidget === 'function') {
      try {
        (node as any).addDOMWidget('tiktok_preview', 'tiktok_preview', wrap, {});
      } catch (e) {
        fallbackMount();
        return;
      }
      wireCallbacks();
      setTimeout(render, 500);
      render();
      return;
    }
    fallbackMount();
  }

  // Fallback for frontends without addDOMWidget: append into the node DOM.
  function fallbackMount() {
    const el = domEl(node);
    if (!el) { setTimeout(fallbackMount, 200); return; }
    if (el.querySelector('.tiktok-preview-widget')) return;
    el.style.overflow = 'hidden';
    el.appendChild(wrap);
    wrap.style.display = 'block';
    wrap.style.gridColumn = '1 / -1';
    wireCallbacks();
    el.addEventListener('change', render, true);
    setTimeout(render, 500);
    render();
  }

  mountPreview();
}

function waitForApp() {
  if ((window as any).LiteGraph?.LGraphNode) {
    const orig = (window as any).LiteGraph.LGraphNode.prototype.onNodeCreated;
    (window as any).LiteGraph.LGraphNode.prototype.onNodeCreated = function (this: any) {
      if (orig) orig.apply(this, arguments);
      setTimeout(() => {
        if (this.type === 'TikTokCaptionNode' || this.comfyClass === 'TikTokCaptionNode') {
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
