// Shared font loader. The tscaps gallery cards (and the per-template live
// preview) reference bundled families via `font-family: var(--tscaps-font-family)`.
// Those families are NEVER registered in the DOM (tscaps relies on an external
// `fonts.css` we don't ship), so without this every card silently falls back to
// the SAME system font — making it look like one template's font "spread" to all
// the other gallery cards, and the bundled tscaps fonts never get wired up.
//
// We fetch each family's @font-face CSS from Google (CORS-enabled) and inline
// the font files as data: URIs, then inject a single <style> into <head> ONCE.
// Each card still only USES the family named in its own --tscaps-font-family
// var, so cards stay visually isolated (no cross-bleed) — they just now actually
// resolve to the correct font instead of the system fallback.

const fontCssCache = new Map<string, string>();

// Canonical Google Fonts family names differ from the "X Variable" names some
// templates use in CSS. Normalize before querying; fix known mismatches.
const FONT_ALIASES: Record<string, string> = { 'Space Grotesque': 'Space Grotesk' };
export function normFont(family: string): string {
  let f = String(family || '').trim().replace(/^['"]|['"]$/g, '');
  if (f.toLowerCase().endsWith(' variable')) f = f.slice(0, -(' variable'.length));
  return FONT_ALIASES[f] || f;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function fetchGoogleFontCss(family: string): Promise<string> {
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
        // Guard: the route may return empty/non-CSS (offline / error). Only
        // accept it if it actually looks like @font-face CSS.
        if (css && css.includes('@font-face')) {
          fontCssCache.set(fam, css);
          return css;
        }
      }
    } catch { /* fall back to a direct Google fetch */ }
    // Fallback: fetch Google directly (its responses are CORS-enabled) and
    // inline each font file as a data: URI ourselves.
    const enc = encodeURIComponent(fam);
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

let bundledInjected = false;
/** Families the 35 bundled tscaps templates actually reference (kept in sync
 *  with the template.json typography.fontFamily values). Wired globally so
 *  the gallery cards resolve their --tscaps-font-family instead of the
 *  system fallback. "X Variable" entries are registered under that exact name
 *  (Google's face is rewritten from "X"). */
export const BUNDLED_GALLERY_FONTS = [
  'Anton', 'Bebas Neue', 'Bricolage Grotesque Variable', 'Bungee',
  'Caveat Variable', 'Inter Variable', 'JetBrains Mono Variable', 'Komika Axis',
  'Lobster', 'Lora Variable', 'Montserrat Variable', 'Playfair Display Variable',
  'Poppins', 'Righteous', 'VT323',
];

// Local font files shipped with the node (not on Google Fonts). Map the exact
// family name the template stores in CSS → a same-origin URL we can embed.
const LOCAL_FONTS: Record<string, string> = {
  'Komika Axis': '/extensions/Comfyui-Caption-Live/fonts/komika-axis.woff2',
};

/** Build an @font-face block for a LOCAL (same-origin) font file, inlined as a
 *  base64 data: URI so it works inside the SVG foreignObject isolated context
 *  too (no extra fetch). Returns '' if the file can't be read. */
async function buildLocalFontFace(family: string, url: string): Promise<string> {
  try {
    const resp = await fetch(url);
    if (!resp.ok) return '';
    const buf = new Uint8Array(await resp.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    const b64 = btoa(bin);
    return `@font-face{font-family:'${family}';src:url(data:font/woff2;base64,${b64}) format('woff2');font-weight:normal;font-style:normal;font-display:swap;}`;
  } catch { return ''; }
}
/**
 * Inject @font-face data:URIs for every bundled family into <head> once, so the
 * gallery cards (and templates) resolve their --tscaps-font-family to the real
 * font instead of the system fallback. `families` may use the "X Variable" form
 * the templates store in CSS; the registered @font-face is rewritten to keep
 * that exact family name so the template var resolves.
 */
export async function ensureBundledFonts(families: string[]): Promise<void> {
  if (bundledInjected || document.getElementById('tscaps-bundled-fonts')) return;
  bundledInjected = true;
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const fam of families) {
    const f = String(fam || '').trim();
    if (!f) continue;
    const norm = normFont(f);
    if (seen.has(norm)) continue;
    seen.add(norm);
    // Local (same-origin) font shipped with the node — embed directly.
    if (LOCAL_FONTS[f]) {
      const localCss = await buildLocalFontFace(f, LOCAL_FONTS[f]);
      if (localCss) parts.push(localCss);
      continue;
    }
    let css = await fetchGoogleFontCss(norm);
    if (!css) continue;
    // Templates keep the "X Variable" suffix in their --tscaps-font-family var,
    // but Google registers the face as "X". Rewrite so the var resolves.
    if (f.toLowerCase().endsWith(' variable')) {
      const base = f.slice(0, -(' variable'.length));
      css = css.replace(
        new RegExp(`font-family:\\s*['"]?${escapeRegExp(base)}['"]?`, 'g'),
        `font-family: '${f}'`,
      );
    }
    parts.push(css);
  }
  if (parts.length === 0) return; // offline / fetch failed — leave system fallback
  const style = document.createElement('style');
  style.id = 'tscaps-bundled-fonts';
  style.textContent = parts.join('\n');
  document.head.appendChild(style);
}
