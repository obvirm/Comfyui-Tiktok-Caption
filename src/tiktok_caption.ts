// TikTok Caption (tscaps) — in-node live preview
// Preview renders caption frames directly in the user's browser using the
// same tscaps engine that the headless final renderer uses → 1:1 output.
// Build: npm run build  (see package.json: esbuild --bundle --minify --jsx=automatic
//        with @modules/@tscaps/engine/@ui/@core/@presentation/@styles aliases)

import { mountLiveCaption } from './caption_render';
import { mountTemplateSidebar } from './sidebar_mount';

const TAG = '[TikTok]';

// Checkered transparency pattern for the live preview — mirrors the tscaps
// gallery card preview (TemplateCard CHECKERED_BG) so transparent / dark
// subtitle styles read clearly on a neutral surface instead of a solid
// black box. Square tint is a faint light over the dark base.
const PREVIEW_CHECKER_SQUARE = 'rgba(255, 255, 255, 0.07)';
const PREVIEW_CHECKER_BASE = 'rgb(22, 22, 22)';
const PREVIEW_CHECKER_BG = [
  `linear-gradient(45deg, ${PREVIEW_CHECKER_SQUARE} 25%, transparent 25%)`,
  `linear-gradient(-45deg, ${PREVIEW_CHECKER_SQUARE} 25%, transparent 25%)`,
  `linear-gradient(45deg, transparent 75%, ${PREVIEW_CHECKER_SQUARE} 75%)`,
  `linear-gradient(-45deg, transparent 75%, ${PREVIEW_CHECKER_SQUARE} 75%)`,
].join(', ');
const PREVIEW_CHECKER_SIZE = '14px 14px';
const PREVIEW_CHECKER_POS = '0 0, 0 7px, 7px -7px, -7px 0px';

// ── Font loading ───────────────────────────────────────────────────
// Fonts must be embedded as @font-face with data: URIs inside the SVG
// foreignObject, because that context is isolated from the main page
// (where <link>-loaded Google Fonts live). We fetch the @font-face CSS
// straight from Google (its responses are CORS-enabled, access-control-
// allow-origin: *) and inline every font file as a data: URI, ONCE per
// family, cached so renders never refetch. Going direct avoids any
// in-front reverse proxy that would otherwise intercept a local route.
const fontCssCache = new Map<string, string>();

// Canonical Google Fonts family names differ from the "X Variable" names some
// templates use in CSS. Normalize before querying; fix known mismatches.
const FONT_ALIASES: Record<string, string> = { 'Space Grotesque': 'Space Grotesk' };
function normFont(family: string): string {
  let f = String(family || '').trim().replace(/^['"]|['"]$/g, '');
  if (f.toLowerCase().endsWith(' variable')) f = f.slice(0, -(' variable'.length));
  return FONT_ALIASES[f] || f;
}

async function fetchGoogleFontCss(family: string): Promise<string> {
  const fam = normFont(family);
  if (!fam) return '';
  if (fontCssCache.has(fam)) return fontCssCache.get(fam)!;
  try {
    // Preferred: our own same-origin /api route. Behind a reverse proxy the
    // browser's direct CORS fetch to fonts.googleapis.com is blocked, but the
    // server can fetch + inline the @font-face server-side and return it
    // same-origin (no CORS). The CSS already has data: URIs inlined.
    try {
      const resp = await fetch(`/api/caption/font-css?family=${encodeURIComponent(fam)}`);
      if (resp.ok) {
        const css = await resp.text();
        fontCssCache.set(fam, css);
        return css;
      }
    } catch { /* fall back to a direct Google fetch */ }
    // Fallback: fetch Google directly (its responses are CORS-enabled) and
    // inline each font file as a data: URI ourselves.
    const enc = encodeURIComponent(fam);
    // Variable fonts accept the weight-range axis; static-only fonts 400 on
    // that, so fall back to the plain request. The browser sends its own
    // Chrome UA, so Google returns woff2 (no manual UA spoofing needed).
    let css = '';
    for (const cand of [
      `https://fonts.googleapis.com/css2?family=${enc}:wght@100..900&display=swap`,
      `https://fonts.googleapis.com/css2?family=${enc}&display=swap`,
    ]) {
      try {
        const resp = await fetch(cand);
        if (resp.ok) { css = await resp.text(); break; }
      } catch { /* try next candidate */ }
    }
    if (!css) { fontCssCache.set(fam, ''); return ''; }
    // Inline each font file url() as a data: URI (fonts.gstatic.com is also
    // CORS-enabled, so the browser can fetch + embed them directly).
    const urlRegex = /url\(\s*(['"]?)(.*?)\1\s*\)/g;
    const urls = [...new Set([...css.matchAll(urlRegex)].map(m => m[2]).filter(u => u && !u.startsWith('data:')))];
    const reps = await Promise.all(urls.map(async (u) => {
      try {
        const r = await fetch(u);
        if (!r.ok) return null;
        const blob = await r.blob();
        const dataUrl = await new Promise<string>((res, rej) => {
          const fr = new FileReader();
          fr.onloadend = () => res(fr.result as string);
          fr.onerror = rej;
          fr.readAsDataURL(blob);
        });
        return { u, dataUrl };
      } catch { return null; }
    }));
    for (const rep of reps) if (rep) css = css.split(rep.u).join(rep.dataUrl);
    fontCssCache.set(fam, css);
    return css;
  } catch { fontCssCache.set(fam, ''); return ''; }
}

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

// A real template name is one of the served folders — never a hex color or the
// neutral default. Guards against a corrupted widget value (e.g. a color picker
// leak) being used to build a template fetch path.
function isValidTemplate(t: any): boolean {
  return typeof t === 'string' && t.length > 0 && t !== '(none / custom)' && !t.startsWith('#');
}

function setupWidget(node: any): void {
  if (node.__tw) return;
  node.__tw = true;

  let rafId: number | null = null;
  let liveHandle: any = null;
  // Serialize renders: never let two render() runs overlap. If a change
  // arrives while rendering, mark dirty and re-run once it finishes.
  let rendering = false;
  let dirty = false;
  // Cache the inlined @font-face CSS keyed on template + effective font so we
  // only fetch/inject a font when the font (or template) actually changes.
  let lastFontKey = '';
  let cachedFontCss = '';
  // Preview background image — PREVIEW ONLY. Never baked into the output
  // frames (which stay transparent for later compositing). Shows the caption
  // composited over a reference image so placement/look can be judged.
  let bgImage: HTMLImageElement | null = null;
  let bgUrl: string | null = null;
  function loadBg(url: string): Promise<HTMLImageElement | null> {
    return new Promise((res) => {
      const im = new Image();
      im.crossOrigin = 'anonymous';
      im.onload = () => res(im);
      im.onerror = () => res(null);
      im.src = url;
    });
  }

  function cleanup() {
    if (rafId != null) { cancelAnimationFrame(rafId); rafId = null; }
    if (liveHandle) { try { liveHandle.dispose(); } catch {} liveHandle = null; }
  }

  const wrap = document.createElement('div');
  wrap.style.cssText = 'width:100%;display:flex;flex-direction:row;align-items:flex-start;gap:12px;';
  wrap.className = 'tiktok-preview-widget';

  // Left column: the live caption preview.
  const leftCol = document.createElement('div');
  leftCol.style.cssText = 'display:flex;flex-direction:column;flex:1 1 auto;min-width:0;';

  const row = document.createElement('div');
  row.style.cssText = 'width:100%;display:flex;align-items:center;gap:8px;margin:4px 0 8px;';
  const lbl = document.createElement('span');
  lbl.style.cssText = 'color:#999;font-size:11px;white-space:nowrap';
  lbl.textContent = 'Preview:';
  row.appendChild(lbl);

  const tplBtn = document.createElement('button');
  tplBtn.textContent = '📚 Templates';
  tplBtn.title = 'Open template gallery';
  tplBtn.style.cssText = 'margin-left:auto;background:#222;color:#eee;border:1px solid #555;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;';
  tplBtn.onclick = () => { (window as any).TikTokCaptionSidebar?.toggle(); };
  row.appendChild(tplBtn);

  const c = document.createElement('div');
  // The preview box size is set explicitly in px at render time (render())
  // to the EXACT output aspect ratio, so the frame can never be stretched.
  // margin:0 auto centers it inside the node; it is the empty "wadah".
  c.style.cssText = 'margin:0 auto;box-sizing:border-box;background:transparent;position:relative;overflow:hidden;border-radius:4px;border:2px solid #444';
  // On first layout, adopt the output aspect ratio so the box isn't squashed
  // before the first render() runs.
  c.style.aspectRatio = '9 / 16';

  // Live-DOM preview host — mountLiveCaption fills this with the real-time
  // caption DOM (segment → line → word) and drives it via requestAnimationFrame.
  const liveHost = document.createElement('div');
  liveHost.style.cssText = 'position:absolute;inset:0;';
  c.appendChild(liveHost);

  const st = document.createElement('span');
  st.style.cssText = 'position:absolute;bottom:4px;left:4px;color:#aaa;font-size:10px;font-family:monospace;background:rgba(0,0,0,0.7);padding:1px 5px;border-radius:3px;pointer-events:none;z-index:1';
  c.appendChild(st);

  leftCol.appendChild(row);
  leftCol.appendChild(c);

  wrap.appendChild(leftCol);

  async function render() {
    // If a render is already in flight, just mark dirty and let it re-run
    // when done (prevents overlapping renders → flicker).
    if (rendering) { dirty = true; return; }
    rendering = true;
    cleanup();
    const srt = getWidgetVal(node, 'srt') || '';
    const width = parseInt(getWidgetVal(node, 'width') || '540');
    const height = parseInt(getWidgetVal(node, 'height') || '960');
    if (!srt.trim()) { st.textContent = 'no srt'; rendering = false; return; }
    // --- NATIVE PREVIEW ---
    // Render the caption at the EXACT output resolution (width x height) so
    // the preview is pixel-identical (1:1) to the headless final render. No
    // downscale / proxy: the engine's `cqh` font sizing runs at the true frame
    // size, and CSS only displays the finished canvas scaled to fit the box.
    const pw = Math.max(1, Math.round(width));
    const ph = Math.max(1, Math.round(height));
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
    const tpl = isValidTemplate(template) ? template : '';
    if (tpl) {
      try {
        const [cssTxt, jsonTxt] = await Promise.all([
          fetch(`/extensions/Comfyui-Caption-Live/templates/${tpl}/style.css`).then(r => r.text()),
          fetch(`/extensions/Comfyui-Caption-Live/templates/${tpl}/template.json`).then(r => r.text()),
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
    const text_color = String(getWidgetVal(node, 'text_color') || '').trim();
    if (text_color) inline['--tscaps-primary-color'] = text_color;
    const highlight_color = String(getWidgetVal(node, 'highlight_color') || '').trim();
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
    const maxWords = parseInt(getWidgetVal(node, 'max_words') || '12') || 12;
    const maxLines = parseInt(getWidgetVal(node, 'max_lines') || '2') || 2;
    // gap-free: eliminate flicker between segments.
    const gapFree = !!getWidgetVal(node, 'gap_free');
    // outline (text stroke): width in em + color.
    const outline = parseFloat(getWidgetVal(node, 'outline') || '0.02') || 0;
    const outlineColor = String(getWidgetVal(node, 'outline_color') || '').trim();
    // Outline corner style: flat | rounded | sharp.
    const outlineStyle = getWidgetVal(node, 'outline_style') || 'flat';
    // font family: override or template default, embedded as @font-face with
    // data: URIs so it is available inside the SVG foreignObject context.
    const fontFamily = getWidgetVal(node, 'font_family') || '(template default)';
    const templateFont = inline['--tscaps-font-family'] || '';
    const effectiveFont = (fontFamily && fontFamily !== '(template default)') ? fontFamily : templateFont;
    let fontCss = '';
    if (effectiveFont) {
      const norm = normFont(effectiveFont);
      const fontKey = (tpl || '') + '|' + norm;
      if (fontKey !== lastFontKey) {
        cachedFontCss = await fetchGoogleFontCss(norm);
        lastFontKey = fontKey;
      }
      fontCss = cachedFontCss;
      // When the user overrides the font, point the inline var at the
      // canonical name so it matches the embedded @font-face.
      if (fontFamily && fontFamily !== '(template default)') {
        inline['--tscaps-font-family'] = `'${norm}'`;
      }
    }
    // Resolve the preview background image (preview-only reference layer).
    const bgv = getWidgetVal(node, 'preview_image');
    let wantBg: string | null = null;
    if (bgv) {
      if (typeof bgv === 'string') wantBg = bgv;
      else if (typeof bgv === 'object' && (bgv as any).filename)
        wantBg = `/view?filename=${encodeURIComponent((bgv as any).filename)}&subfolder=${encodeURIComponent((bgv as any).subfolder || '')}&type=${encodeURIComponent((bgv as any).type || 'input')}`;
    }
    if (wantBg !== bgUrl) {
      bgUrl = wantBg;
      bgImage = wantBg ? await loadBg(wantBg) : null;
    }
    // Preview surface: a checkered transparency pattern (like the tscaps
    // gallery card) so the caption's transparency reads clearly. When the user
    // supplies a preview_image it is shown behind the caption as a reference
    // layer (never baked into the transparent output frames).
    if (wantBg) {
      c.style.backgroundColor = 'transparent';
      c.style.backgroundImage = `url("${wantBg}")`;
      c.style.backgroundSize = 'cover';
      c.style.backgroundPosition = 'center';
    } else {
      c.style.backgroundColor = PREVIEW_CHECKER_BASE;
      c.style.backgroundImage = PREVIEW_CHECKER_BG;
      c.style.backgroundSize = PREVIEW_CHECKER_SIZE;
      c.style.backgroundPosition = PREVIEW_CHECKER_POS;
    }
    st.textContent = 'rendering…';
    try {
      // LIVE-DOM preview: build the caption DOM once and drive it with
      // requestAnimationFrame. No rasterization → runs at display refresh,
      // zero per-frame cost, and CSS animations play natively (the offline
      // renderer can't capture those). Word timings/classes come from the
      // same engine Document model, so the look matches the export.
      liveHandle = await mountLiveCaption(liveHost, {
        srt, css, width: pw, height: ph, inlineStyles: inline, alignment,
        splitWordsIntoLetters: splitLetters, textCase, maxWords, maxLines, gapFree,
        outline, outlineColor, outlineStyle, fontCss,
        // Scope the template CSS to this node's host so :root / top-level
        // selectors (e.g. .caption-word color) don't leak document-wide and
        // bleed into the gallery's previews. Without this the gallery cards
        // inherit the applied template's colors.
        scopeClass: 'tscaps-live-node-' + node.id,
      });
      st.textContent = `live • ${liveHandle.duration.toFixed(1)}s`;
      if (liveHandle.duration <= 0) { rendering = false; return; }
      const rafStart = performance.now();
      const tick = (now: number) => {
        // Loop the caption timeline continuously.
        const t = ((now - rafStart) / 1000) % liveHandle.duration;
        liveHandle.seek(t);
        rafId = requestAnimationFrame(tick);
      };
      rafId = requestAnimationFrame(tick);
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
    // Remove the old STRING widget first.
    n.widgets.splice(idx, 1);
    // addWidget() appends the new widget to the end; ensure we end up with a
    // SINGLE copy at the original index (older litegraph doesn't append, newer
    // does — handle both so we never create a duplicate widget, which corrupts
    // widget↔input positional mapping).
    const cw = (n as any).addWidget('color', name, defaultHex, () => {});
    const ai = n.widgets.indexOf(cw);
    if (ai !== -1 && ai !== idx) n.widgets.splice(ai, 1);
    n.widgets.splice(idx, 0, cw);
  }

  // Sync the color pickers' values to the active template's default colors
  // (or neutral defaults when no template). This keeps the override a no-op
  // until the user actually picks a different color.
  async function syncColorDefaults(n: any): Promise<void> {
    let pc = '#ffffff';
    let hc = '#ffd400';
    const template = getWidgetVal(n, 'template');
    if (isValidTemplate(template)) {
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
      replaceWithColorWidget(node, 'outline_color', '#000000');
      syncColorDefaults(node);
    } catch (e) {
      node.__twColor = false;
      console.error('[TikTok] color picker setup failed:', e);
    }
  }

  // The template gallery lives in an app-level docked panel (web/js/sidebar.js),
  // opened by the 📚 Templates button below. No in-node sidebar anymore.

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

  // Exposed so the app-level gallery (web/js/sidebar.js) can apply a template
  // to this node. The caller scopes application to the active tab.
  (node as any).tscapsApply = (name: string) => {
    const tw: any = node.widgets?.find((w: any) => w.name === 'template');
    if (tw) {
      tw.value = name;
      if (tw.callback) tw.callback.call(tw, name);
    }
    syncColorDefaults(node);
    render();
  };

  mountPreview();
  // One-time diagnostic to confirm widget↔input mapping is intact.
  try {
    const diag = (node.widgets || []).map((w: any) => `${w.name}=${JSON.stringify(w.value)}`);
    console.log('[TikTok][diag] widgets:', diag.join(' | '));
  } catch (e) { /* ignore */ }
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

// ── App-level template gallery panel ───────────────────────────────────────
// Opened by the 📚 Templates button inside each TikTokCaption node. Docked on
// the right; auto-hides when the active tab has no TikTokCaption node. Template
// application is scoped to the ACTIVE tab (app.rootGraph), so different
// workflows/tabs never cross-apply. Uses the global `window.app` (set by
// ComfyUI) rather than an ESM import so it works as a classic extension script.
const TS_TYPE = 'TikTokCaptionNode';
let tsPanel: HTMLDivElement | null = null;
let tsContent: HTMLDivElement | null = null;
let tsVisible = false;
let tsMounted = false;

function tsMyNodes(): any[] {
  const app = (window as any).app;
  return (app?.rootGraph?.nodes ?? []) as any[];
}
function tsHasMyNode(): boolean {
  return tsMyNodes().some((n: any) => n?.type === TS_TYPE);
}
function tsGetSelected(): string | null {
  const n = tsMyNodes().find((x: any) => x?.type === TS_TYPE);
  const w: any = n?.widgets?.find((x: any) => x.name === 'template');
  return w ? w.value : null;
}
function tsApplyToTab(name: string): void {
  for (const n of tsMyNodes()) {
    if (n?.type === TS_TYPE && typeof (n as any).tscapsApply === 'function') {
      (n as any).tscapsApply(name);
    }
  }
}
function tsEnsurePanel(): HTMLDivElement {
  if (tsPanel) return tsPanel;
  const panel = document.createElement('div');
  panel.id = 'tscaps-gallery-panel';
  panel.style.cssText =
    'position:fixed;top:0;right:0;height:100vh;width:340px;z-index:9998;' +
    'background:rgb(17 17 21);border-left:1px solid rgb(60 60 70);' +
    'box-shadow:-8px 0 24px rgba(0,0,0,.5);overflow:hidden;display:none;';
  const close = document.createElement('button');
  close.textContent = '✕';
  close.title = 'Close gallery';
  close.style.cssText =
    'position:absolute;top:8px;right:10px;z-index:3;width:26px;height:26px;' +
    'border-radius:6px;border:1px solid rgb(60 60 70);background:rgb(36 36 46);' +
    'color:rgb(204 204 204);cursor:pointer;font-size:14px;line-height:1;';
  close.onclick = tsHide;
  const content = document.createElement('div');
  content.className = 'tscaps-ui-root';
  content.style.cssText =
    'position:absolute;inset:0;overflow-y:auto;padding:14px 12px;box-sizing:border-box;';
  panel.appendChild(close);
  panel.appendChild(content);
  document.body.appendChild(panel);
  tsPanel = panel;
  tsContent = content;
  return panel;
}
function tsShow(): void {
  tsEnsurePanel();
  if (!tsContent) return;
  tsVisible = true;
  tsPanel!.style.display = 'block';
  if (!tsMounted) {
    tsMounted = true;
    fetch('/extensions/Comfyui-Caption-Live/templates/manifest.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((names: string[]) => {
        if (!tsContent) return;
        mountTemplateSidebar(tsContent, {
          names: Array.isArray(names) ? names : [],
          getSelected: tsGetSelected,
          onSelect: (name: string) => tsApplyToTab(name),
        });
      })
      .catch((e) => {
        console.error('[tscaps] failed to load template manifest', e);
        if (tsContent) {
          tsContent.innerHTML =
            '<div style="color:rgb(248 113 113);padding:8px">Failed to load templates</div>';
        }
      });
  }
}
function tsHide(): void {
  tsVisible = false;
  if (tsPanel) tsPanel.style.display = 'none';
}
function tsToggle(): void {
  if (tsVisible) tsHide();
  else tsShow();
}
function tsRecompute(): void {
  if (tsVisible && !tsHasMyNode()) tsHide();
}
(window as any).TikTokCaptionSidebar = { toggle: tsToggle, show: tsShow, hide: tsHide };

// Bind auto-hide events once ComfyUI's `app` global is ready. Bind directly
// (not only via registerExtension) so it works regardless of registration
// order. registerExtension is still called for correctness/consistency.
function tsSetupSidebar(): void {
  const tryInit = () => {
    const app = (window as any).app;
    if (!app || !app.api) {
      setTimeout(tryInit, 200);
      return;
    }
    app.api.addEventListener('graphChanged', () => tsRecompute());
    const bindCanvas = () => {
      const canvasEl = app.canvas?.canvas;
      if (canvasEl) canvasEl.addEventListener('litegraph:set-graph', () => tsRecompute());
      else setTimeout(bindCanvas, 200);
    };
    bindCanvas();
    if (typeof app.registerExtension === 'function') {
      app.registerExtension({ name: 'Comfyui-Caption-Live.Sidebar', setup() {} });
    }
  };
  tryInit();
}
tsSetupSidebar();
