/**
 * TikTok Caption — shared caption rendering API (browser-side).
 * Uses vendored tscaps engine: CSS-styled captions from SRT input.
 * Consumed by both the in-node preview (frontend) and the headless
 * final renderer (CloakBrowser) so preview === output (1:1).
 */
import { SrtTranscriber } from '@modules/transcription/SrtTranscriber';
import { ensureBundledFonts, BUNDLED_GALLERY_FONTS } from './font_loader';
import {
  BoundarySegmentSplitter,
  LimitByCharsSegmentSplitter,
  SpeakerChangeSegmentSplitter,
  BalancedLineSplitter,
} from '@modules/splitting';
// Polyfill crypto.randomUUID for headless Chromium contexts that lack it
try { if (typeof crypto !== 'undefined' && !crypto.randomUUID) {
  (crypto as any).randomUUID = () => 'id-' + Math.random().toString(16).slice(2);
} } catch {}

/**
 * Template CSS references shared binary assets as `url('asset:<id>')`.
 * tscaps's real loader rewrites those to resolved URLs; our vendored UI
 * gallery passes a stub repo that returns null, so the raw `asset:` token
 * would leak into the DOM and the browser would try to fetch the `asset:`
 * scheme (→ "Cross-Origin Request Blocked: ... asset:marker-stroke").
 * We rewrite the tokens ourselves to the actual served file path.
 */
const ASSET_BASE = '/extensions/Comfyui-Caption-Live/templates/_assets';
function resolveAssetRefs(css: string): string {
  if (!css || css.indexOf('asset:') === -1) return css;
  // Our shared asset pool only holds PNGs today (marker-stroke.png, ...),
  // referenced as `asset:<name>` (no extension). Append `.png`.
  return css.replace(/asset:([a-zA-Z0-9_-]+)/g, (_m, id) => `${ASSET_BASE}/${id}.png`);
}

import {
  createRenderer,
  BrowserCssResourceEmbedder,
  GraphemeWordSplitter,
  StructureTagger,
} from './tscaps_bridge';
import { Document } from '@modules/document/Document';
import { Segment } from '@modules/document/Segment';
import { Line } from '@modules/document/Line';
import { Word } from '@modules/document/Word';
import { Section } from '@modules/document/Section';
import { TimeFragment } from '@modules/document/TimeFragment';
import type {
  SubtitleStyle,
  SubtitleFrameRenderer,
} from '@modules/rendering/SubtitleFrameRenderer';
// CssScoper + CssVariable are the SAME engine modules tscaps's TemplateCard
// preview uses to isolate each template's stylesheet (see
// TemplatePreviewArtifactsBuilder.buildScopedCss). Reusing them 1:1 keeps the
// library preview identical to tscaps.
import { CssScoper } from '@modules/css/CssScoper';
import { CssVariable } from '@modules/document/CssVariable';

export interface CaptionParams {
  srt: string;
  css: string;
  width: number;
  height: number;
  inlineStyles?: Record<string, string>;
  alignment?: {
    verticalAlign: string;
    verticalOffset: number;
    horizontalAlign: string;
    horizontalOffset: number;
  };
  splitWordsIntoLetters?: boolean;
  textCase?: string;
  /** tscaps-native Layout controls (Scenes + Lines splitters). Mirrors the
   *  tscaps editor Layout tab. All fields optional; omitted fields leave the
   *  segment/line grouping as the SRT authored it. */
  layout?: LayoutParams;
  /** Outline (text stroke) width in em. Drives --tscaps-outline-width.
   *  0 = no outline. */
  outline?: number;
  /** Outline (text stroke) color. Drives --tscaps-outline-color. */
  outlineColor?: string;
  /** Outline corner style: boolean. false = flat (centered stroke,
   *  default); true = sharp (hard pointed outline via feMorphology filter
   *  in preview / 8-copy text-shadow in headless export). "rounded" removed. */
  outlineStyle?: boolean;
  gapFree?: boolean;
  /** @font-face CSS (with data: URIs) so fonts render inside the SVG
   *  foreignObject isolated document context. Pre-inlined by the caller
   *  to avoid per-render network fetches. */
  fontCss?: string;
  /**
   * When set, the injected stylesheet is scoped under `.${scopeClass}` and
   * the host element carries that class — the exact recipe tscaps uses so
   * many template previews can coexist without their CSS bleeding across
   * cards. @keyframes are renamed per-scope and `::before`/`::after` get a
   * `!important` paused rule (templates animate pseudos the shorthand would
   * otherwise leave running). Leave unset for the single-template main preview.
   */
  scopeClass?: string;
  /**
   * Use the tscaps TemplatePreviewMock document (one segment, one line, the
   * three words "This is tscaps" with per-word timing) instead of `srt`. All
   * words stay visible while the karaoke highlight sweeps — identical to what
   * every card in tscaps's template library shows.
   */
  usePreviewMock?: boolean;
}

/** tscaps-native Layout controls (Scenes + Lines splitters). Mirrors the
 *  tscaps editor Layout tab. All fields optional; omitted fields leave the
 *  segment/line grouping exactly as the source SRT authored it. */
export interface LayoutParams {
  /** Scenes: "Split scenes by speaker" toggle (mono-speaker boundaries). */
  splitBySpeaker?: boolean;
  /** Scenes: "Split scenes by" boundary mode → sentence / clause / none. */
  boundaryMode?: 'none' | 'sentence' | 'clause';
  /** Scenes: Max letters per scene (limit_by_chars maxChars). 0 = off. */
  maxLetters?: number;
  /** Scenes: Min letters per scene (limit_by_chars minChars). 0 = off. */
  minLetters?: number;
  /** Lines: max lines per scene. 0 = off. */
  maxLines?: number;
  /** Lines: min lines per scene. 0 = off. */
  minLines?: number;
  /** Lines: max line width as a fraction of frame width (0..1). 0 = off. */
  maxLineWidth?: number;
}

/** Internal sampling rate (frames per second of caption timeline).
 *  NOT exposed as a parameter — kept fixed so the in-node preview and the
 *  headless final render produce the EXACT same number of frames (1:1). */
export const SAMPLE_FPS = 30;

const DEFAULT_ALIGNMENT = {
  verticalAlign: 'bottom',
  verticalOffset: 0.85,
  horizontalAlign: 'center',
  horizontalOffset: 0.5,
};

/**
 * Accept either valid SRT (contains "-->") or plain text.
 * Plain text: each non-empty line becomes one caption segment (2s each).
 * This lets the node work as a plain "text" caption box OR a precise SRT box.
 */
export function normalizeCaptionInput(raw: string): string {
  const trimmed = (raw || '').trim();
  if (!trimmed) return '';
  if (/-->/.test(trimmed)) return trimmed; // already SRT
  const lines = trimmed.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return '';
  const perLine = 2.0;
  const f = (t: number): string => {
    const ms = Math.round((t % 1) * 1000);
    const s = Math.floor(t) % 60;
    const m = Math.floor(t / 60) % 60;
    const h = Math.floor(t / 3600);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };
  let srt = '';
  lines.forEach((line, i) => {
    const start = i * perLine;
    const end = (i + 1) * perLine;
    srt += `${i + 1}\n${f(start)} --> ${f(end)}\n${line}\n\n`;
  });
  return srt.trim();
}

export async function srtToDocument(srt: string): Promise<any> {
  const normalized = normalizeCaptionInput(srt);
  if (!normalized) throw new Error('Empty caption input');
  const tr = new SrtTranscriber(normalized);
  const doc = await tr.transcribe(new Blob(), {});
  // Apply structural tags (first-word-in-line, last-word-in-segment, etc.)
  // so CSS rules targeting positional elements work.
  const tagger = new StructureTagger();
  return tagger.tag(doc);
}

// ── Document post-processing helpers ──────────────────────────────────

/**
 * tscaps-native Layout pipeline. Mirrors the tscaps editor Layout tab:
 *   SCENES (segment splitters, run in order):
 *     1. SpeakerChangeSegmentSplitter  — split scenes by speaker
 *     2. BoundarySegmentSplitter       — split at sentence/clause punctuation
 *     3. LimitByCharsSegmentSplitter    — max/min letters per scene
 *   LINES (line splitter, run after segments):
 *     4. BalancedLineSplitter           — max/min lines, max line width (px)
 * Each splitter is a no-op when its controlling field is 0/'(auto)'/off,
 * so an untouched Layout leaves the source SRT grouping exactly as authored.
 * Word timings (karaoke) are preserved because the splitters only regroup
 * the existing Word objects — they never re-time anything.
 */
function applyLayout(doc: Document, layout: LayoutParams | undefined): Document {
  if (!layout) return doc;
  let d = doc;
  // 1) split by speaker
  if (layout.splitBySpeaker) {
    d = applySplitter(d, SpeakerChangeSegmentSplitter, true);
  }
  // 2) boundary punctuation
  const mode = layout.boundaryMode;
  if (mode === 'sentence') {
    d = applySplitter(d, BoundarySegmentSplitter, { separators: ['.', '!', '?'] });
  } else if (mode === 'clause') {
    d = applySplitter(d, BoundarySegmentSplitter, { separators: ['.', '!', '?', ',', ';', ':'] });
  }
  // 3) max/min letters per scene
  if (layout.maxLetters && layout.maxLetters > 0) {
    d = applySplitter(d, LimitByCharsSegmentSplitter, {
      maxChars: layout.maxLetters,
      minChars: layout.minLetters && layout.minLetters > 0 ? layout.minLetters : 0,
      minDuration: 0,
      minLastWordDuration: 0,
    });
  }
  // 4) lines
  if (layout.maxLines && layout.maxLines > 0) {
    const maxWidthRatio = layout.maxLineWidth && layout.maxLineWidth > 0 ? layout.maxLineWidth : 0.8;
    d = applyLineSplitter(d, BalancedLineSplitter, {
      maxLines: layout.maxLines,
      minLines: layout.minLines && layout.minLines > 0 ? layout.minLines : 1,
      maxCharsPerLine: Math.max(8, Math.round((layout.maxLetters && layout.maxLetters > 0 ? layout.maxLetters : 28))),
      // maxLineWidth is a fraction of frame width; tscaps uses a pixel measurer
      // but for our static render we approximate via maxCharsPerLine derived
      // from the width fraction could be added later. Keep maxCharsPerLine.
      _maxWidthRatio: maxWidthRatio,
    });
  }
  return new StructureTagger().tag(d);
}

/** Run a SegmentSplitter over the document, returning a freshly built doc. */
function applySplitter(doc: Document, Ctor: any, config: any): Document {
  const splitter = new Ctor(config);
  const segments = splitter.split(doc.getSegments());
  const SectionCtor: any = (doc.sections[0] as any).constructor;
  const newSection = new SectionCtor({ segments, kind: doc.sections[0].kind });
  return doc.with({ sections: [newSection] });
}

/** Run a LineSplitter over the document, returning a freshly built doc. */
function applyLineSplitter(doc: Document, Ctor: any, config: any): Document {
  const splitter = new Ctor(config);
  const segments = splitter.split(doc.getSegments());
  const SectionCtor: any = (doc.sections[0] as any).constructor;
  const newSection = new SectionCtor({ segments, kind: doc.sections[0].kind });
  return doc.with({ sections: [newSection] });
}

/**
 * Extend each segment's end time to the start of the next segment
 * (or +0.5s for the last segment) to eliminate flicker.
 */
function applyGapFree(doc: Document): Document {
  const segments = doc.getSegments();
  const newSections = doc.sections.map((section: any) => {
    const newSegments = section.segments.map((seg: any) => {
      const nextSeg = segments[segments.indexOf(seg) + 1];
      const newEnd = nextSeg ? nextSeg.time.start : seg.time.end + 0.5;
      if (newEnd <= seg.time.end) return seg;
      return seg.with({ customTime: new TimeFragment(seg.time.start, newEnd) });
    });
    return section.with({ segments: newSegments });
  });
  return doc.with({ sections: newSections });
}

/** Bundle a template folder's style.css + its default CSS variables as
 *  inlineStyles so the engine renders identically to tscaps out of the box. */
const TEMPLATE_VARS: Record<string, Record<string,string>> = {};

/** Read all template CSS files from the served /templates dir and load them.
 *  Called once from the extension bootstrap. */
export async function loadTemplateVars(map: Record<string, Record<string,string>>): Promise<void> {
  Object.assign(TEMPLATE_VARS, map);
}

export function getTemplateVars(name: string): Record<string,string> | undefined {
  return TEMPLATE_VARS[name];
}

/**
 * Compute the merged inline CSS-variable map (template vars + outline +
 * text-case overrides) the caption needs. Shared by the offline renderer
 * (`buildStyle`) and the live-DOM preview (`mountLiveCaption`) so both
 * produce the identical look.
 */
function buildInlineVars(params: CaptionParams): Record<string, string> {
  const inline: Record<string, string> = { ...(params.inlineStyles ?? {}) };
  // text_case → CSS text-transform.
  if (params.textCase && params.textCase !== 'none') {
    inline['--tscaps-text-transform'] = params.textCase;
  }
  // Outline: width + color, applied in one of two corner styles.
  //  • flat  → centered -webkit-text-stroke (one clean stroke, default look)
  //  • sharp → hard 8-direction text-shadow (pointed / lancip corners).
  //
  // The 8-copy text-shadow is the standard CSS outline technique and renders
  // as a SOLID outline in the headless export (rasterized once). In the
  // live-DOM PREVIEW it could look doubled at large sizes, so mountLiveCaption
  // strips these vars for sharp and applies a single feMorphology SVG filter
  // instead (no duplication, true pointed corners). "rounded" removed.
  if (params.outline != null && params.outline > 0) {
    const w = `${params.outline}em`;
    const c = params.outlineColor || '#000';
    const sharp = params.outlineStyle === true || params.outlineStyle === 'sharp';
    if (!sharp) { // flat
      inline['--tscaps-outline-width'] = w;
      inline['--tscaps-outline-color'] = c;
    } else { // sharp / lancip
      inline['--tscaps-outline-width'] = '0em';
      inline['--tscaps-outline-color'] = c;
      inline['--tscaps-outline-shadow'] =
        `${w} 0 0 ${c}, -${w} 0 0 ${c}, 0 ${w} 0 ${c}, 0 -${w} 0 ${c}, ` +
        `${w} ${w} 0 ${c}, -${w} ${w} 0 ${c}, ${w} -${w} 0 ${c}, -${w} -${w} 0 ${c}`;
    }
  }
  return inline;
}

function buildStyle(params: CaptionParams): Record<string, SubtitleStyle> {
  // Prepend fontCss (pre-inlined @font-face with data: URIs) so the
  // engine renders the font inside the SVG foreignObject isolated doc.
  const fullCss = params.fontCss ? params.fontCss + '\n' + params.css : params.css;
  // Rewrite template `asset:<id>` references to the served file URL so the
  // engine's raster path doesn't try to fetch the bogus `asset:` scheme.
  const resolvedCss = resolveAssetRefs(fullCss);
  const inline = buildInlineVars(params);
  const style: SubtitleStyle = {
    css: resolvedCss,
    inlineStyles: inline,
    alignment: (params.alignment as any) ?? DEFAULT_ALIGNMENT,
    rendering: {
      splitWordsIntoLetters: params.splitWordsIntoLetters ?? false,
      videoFrame: { required: false, jpegQuality: 1 },
      padding: null,
    },
  };
  return { '': style };
}

function makeRenderer(): SubtitleFrameRenderer {
  // Fresh renderer per call (renderer holds document state; reuse is unsafe
  // across documents in the same page context).
  return createRenderer(
    new BrowserCssResourceEmbedder() as any,
    new GraphemeWordSplitter() as any,
  ) as any;
}

/** Render one frame at timestamp t (seconds) → PNG data URL. */
export async function renderCaptionFrame(params: CaptionParams, t: number): Promise<string> {
  let doc = await srtToDocument(params.srt);
  if (params.layout) doc = applyLayout(doc, params.layout);
  if (params.gapFree) doc = applyGapFree(doc);
  const styles = buildStyle(params);
  const renderer = makeRenderer();
  await (renderer as any).open(doc, styles, params.width, params.height);
  const frame = await (renderer as any).getFrame(t);
  const canvas = document.createElement('canvas');
  canvas.width = params.width;
  canvas.height = params.height;
  const ctx = canvas.getContext('2d')!;
  if (frame) frame.draw(ctx, 0, 0, params.width, params.height);
  await (renderer as any).close();
  return canvas.toDataURL('image/png');
}

/** Render all frames across the SRT timeline → array of PNG data URLs.
 *  Used by the headless final renderer (CloakBrowser) which needs
 *  serializable data URLs. Sampling rate is internal SAMPLE_FPS.
 *  The in-node live preview uses renderCaptionFramesToBitmaps() instead
 *  (no toDataURL/fetch/decode round-trip → fast, no flicker). */
export async function renderCaptionFrames(
  params: CaptionParams,
  fps: number = SAMPLE_FPS,
): Promise<string[]> {
  let doc = await srtToDocument(params.srt);
  if (params.layout) doc = applyLayout(doc, params.layout);
  if (params.gapFree) doc = applyGapFree(doc);
  const styles = buildStyle(params);
  const renderer = makeRenderer();
  await (renderer as any).open(doc, styles, params.width, params.height);
  const end = doc.getSegments().reduce((m: number, s: any) => Math.max(m, s.time.end), 1);
  const total = Math.max(1, Math.floor(end * fps));
  const out: string[] = [];
  for (let i = 0; i < total; i++) {
    const t = i / fps;
    const frame = await (renderer as any).getFrame(t);
    const canvas = document.createElement('canvas');
    canvas.width = params.width;
    canvas.height = params.height;
    const ctx = canvas.getContext('2d')!;
    if (frame) frame.draw(ctx, 0, 0, params.width, params.height);
    out.push(canvas.toDataURL('image/png'));
  }
  await (renderer as any).close();
  return out;
}

/** Render all frames across the SRT timeline → array of ImageBitmaps.
 *  Used by the in-node live preview. Unlike renderCaptionFrames (which
 *  serializes each frame to a base64 PNG data URL), this returns decoded
 *  ImageBitmaps directly — no toDataURL / fetch / decode round-trip, so the
 *  preview is ~10x cheaper to (re)build on every parameter tweak.
 *  Sampling rate is the internal SAMPLE_FPS (no fps parameter exposed). */
export async function renderCaptionFramesToBitmaps(
  params: CaptionParams,
  fps: number = SAMPLE_FPS,
): Promise<ImageBitmap[]> {
  let doc = await srtToDocument(params.srt);
  if (params.layout) doc = applyLayout(doc, params.layout);
  if (params.gapFree) doc = applyGapFree(doc);
  const styles = buildStyle(params);
  const renderer = makeRenderer();
  await (renderer as any).open(doc, styles, params.width, params.height);
  const end = doc.getSegments().reduce((m: number, s: any) => Math.max(m, s.time.end), 1);
  const total = Math.max(1, Math.floor(end * fps));
  const out: ImageBitmap[] = [];
  for (let i = 0; i < total; i++) {
    const t = i / fps;
    const frame = await (renderer as any).getFrame(t);
    const canvas = document.createElement('canvas');
    canvas.width = params.width;
    canvas.height = params.height;
    const ctx = canvas.getContext('2d')!;
    if (frame) frame.draw(ctx, 0, 0, params.width, params.height);
    out.push(await createImageBitmap(canvas));
  }
  await (renderer as any).close();
  return out;
}

// Headless entry: expose globals
(window as any).TikTokCaption = { renderCaptionFrame, renderCaptionFrames, renderCaptionFramesToBitmaps, srtToDocument, mountLiveCaption };

export interface LiveCaptionHandle {
  /** Total caption timeline length in seconds (last segment end + tail). */
  duration: number;
  /** Update the preview to caption time `t` (seconds). Cheap: flips word
   *  CSS classes only — no rasterization. */
  seek(t: number): void;
  /** Tear down the DOM and stop any loops. */
  dispose(): void;
}

/** Minimal baseline CSS so the live-DOM preview renders like the engine:
 *  the host is a container-query context (cqh font sizing resolves to its
 *  height) and box-sizing is reset. Templates supply the rest. */
const LIVE_BASELINE_CSS = `
.tscaps-live, .tscaps-live * { box-sizing: border-box; }
.tscaps-live { container-type: size; position: absolute; inset: 0; overflow: hidden; }
.tscaps-live .segment { text-align: center; white-space: normal; }
`;

/**
 * Build the engine-faithful anchor for one segment.
 *
 * The real renderer (`SegmentWrapperRenderer.composeAnchorStyle`) never
 * touches `.segment`: it wraps the caption in a 0×0 CSS-grid whose single
 * cell is placed at the alignment point, and uses `align-items` /
 * `justify-items` (start/center/end) to pin the box edge there. `.segment`
 * keeps its own template CSS (display / position / transform) completely
 * intact.
 *
 * Our old live preview instead slapped `position:absolute; top/left;
 * transform` straight onto `.segment`. That blockified `display:inline-block`
 * templates (window chrome like nyx/pico → box stretched to the frame),
 * overrode `position:relative` (broke ::before/::after chrome), and clobbered
 * `transform:translateY(...)` slide-in templates (cleo/mira/noor) — so their
 * preview position drifted. Replicating the engine's grid anchor makes the
 * preview 1:1 with the export for every template.
 *
 * Returns the `anchor` (append to host) and the `wrapper` (append `.segment`
 * to this; it carries the static CSS variables, exactly like
 * `SegmentSubtreeHtmlBuilder.composeWrapperStyle`).
 */
function applyLiveAlignment(align: any): { anchor: HTMLElement; wrapper: HTMLElement } {
  const v = align?.verticalAlign || 'bottom';
  const h = align?.horizontalAlign || 'center';
  const vo = parseFloat(align?.verticalOffset ?? '0.85') || 0.85;
  const ho = parseFloat(align?.horizontalOffset ?? '0.5') || 0.5;

  const anchor = document.createElement('div');
  anchor.style.position = 'absolute';
  anchor.style.top = (vo * 100) + '%';
  anchor.style.left = (ho * 100) + '%';
  anchor.style.width = '0';
  anchor.style.height = '0';
  anchor.style.display = 'grid';
  anchor.style.gridTemplate = '0 / 0';
  anchor.style.alignItems = v === 'top' ? 'start' : v === 'center' ? 'center' : 'end';
  anchor.style.justifyItems = h === 'left' ? 'start' : h === 'center' ? 'center' : 'end';

  const wrapper = document.createElement('div');
  wrapper.style.display = 'inline-block';
  wrapper.style.width = 'max-content';
  wrapper.style.minWidth = '0';
  wrapper.style.minHeight = '0';

  anchor.appendChild(wrapper);
  return { anchor, wrapper };
}

/**
 * Mount a real-time, DOM-based caption preview into `container`.
 *
 * Unlike the bitmap renderers this does NOT rasterize: it builds the
 * segment → line → word DOM once (driven by the engine Document model, so
 * word timings and classes are identical to the export) and on every
 * `seek(t)` only flips each word's CSS classes to match
 * `Word.getCssClasses(t)`. The browser paints the HTML/CSS natively — so it
 * runs at display refresh with zero raster cost, and CSS animations that
 * the offline renderer cannot capture (no timeline there) play live here.
 */
/**
 * tscaps TemplatePreviewMock, ported verbatim: a single segment with a single
 * line holding the three words "This is tscaps", each 0.5s — so all words stay
 * on screen while the karaoke highlight sweeps (rather than swapping one word
 * per cue). This is the exact document every card in tscaps's template library
 * previews against, keeping our library previews deterministic and identical.
 */
const PREVIEW_MOCK_WORDS = ['This', 'is', 'tscaps'];
const PREVIEW_MOCK_WORD_DURATION = 0.5;

export function buildTemplatePreviewDocument(): any {
  const words = PREVIEW_MOCK_WORDS.map(
    (text, index) =>
      new Word({
        text,
        time: new TimeFragment(index * PREVIEW_MOCK_WORD_DURATION, (index + 1) * PREVIEW_MOCK_WORD_DURATION),
      }),
  );
  const line = new Line({ words });
  const segment = new Segment({ lines: [line] });
  const section = new Section({ segments: [segment], kind: 'main' });
  const doc = new Document({ sections: [section] });
  return new StructureTagger().tag(doc);
}

export async function mountLiveCaption(
  container: HTMLElement,
  opts: CaptionParams,
): Promise<LiveCaptionHandle> {
  // Wire the bundled tscaps fonts into the DOM so the live preview (and any
  // template) resolves its --tscaps-font-family to the real face instead of
  // the system fallback. Non-blocking; runs once globally.
  ensureBundledFonts(BUNDLED_GALLERY_FONTS);
  let doc: any;
  if (opts.usePreviewMock) {
    doc = buildTemplatePreviewDocument();
  } else {
    doc = await srtToDocument(opts.srt);
  }
  if (opts.layout) doc = applyLayout(doc, opts.layout);
  if (opts.gapFree) doc = applyGapFree(doc);

  const inline = buildInlineVars(opts);
  const fullCss = (opts.fontCss ? opts.fontCss + '\n' : '') + (opts.css || '');
  // Rewrite `asset:<id>` references to the served file URL so the live-DOM
  // preview doesn't leak the bogus `asset:` scheme into the DOM.
  const fullCssResolved = resolveAssetRefs(fullCss);

  // ── Sharp outline via SVG feMorphology (preview-only) ───────────────────
  // -webkit-text-stroke cannot produce a pointed ("sharp") corner — its join
  // is fixed to the glyph outline, so a single stroke always looks slightly
  // rounded, and faking "lancip" with 8 text-shadow copies just duplicates
  // the glyph (ghost / double image). Instead we inject ONE <filter> that
  // dilates the text's alpha mask (feMorphology operator="dilate") and
  // floods it with the outline color behind the original text (feMerge). One
  // operation, correct thickness, uniform crisp edge, ZERO duplication.
  // (Headless export keeps the standard 8-copy text-shadow from buildInlineVars
  // for sharp — see note there. Preview-only = no ghosting.)
  let outlineFilterId: string | null = null;
  let outlineSvg: SVGSVGElement | null = null;
  if (opts.outline != null && opts.outline > 0) {
    const sharp = opts.outlineStyle === true || opts.outlineStyle === 'sharp';
    if (sharp) {
      // Neutralize the 8-copy text-shadow var so the preview shows ONLY our
      // filter (no double image). flat keeps the centered stroke as-is.
      delete inline['--tscaps-outline-shadow'];
      const ow = Math.max(0, parseFloat(String(opts.outline)) || 0);
      const oc = opts.outlineColor || '#000';
      const fid = `tscaps-outline-${Math.random().toString(36).slice(2, 9)}`;
      outlineFilterId = fid;
      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('width', '0');
      svg.setAttribute('height', '0');
      svg.style.position = 'absolute';
      svg.style.width = '0';
      svg.style.height = '0';
      svg.style.overflow = 'hidden';
      svg.innerHTML =
        `<defs><filter id="${fid}" x="-50%" y="-50%" width="200%" height="200%" color-interpolation-filters="sRGB">` +
        `<feMorphology in="SourceAlpha" operator="dilate" radius="${ow}" result="d"/>` +
        `<feFlood flood-color="${oc}" result="c"/>` +
        `<feComposite in="c" in2="d" operator="in" result="outline"/>` +
        `<feMerge><feMergeNode in="outline"/><feMergeNode in="SourceGraphic"/></feMerge>` +
        `</filter></defs>`;
      outlineSvg = svg;
    }
  }

  container.innerHTML = '';
  const host = document.createElement('div');
  // Mirrors tscaps TemplateCard: when a scopeClass is given the host carries it
  // and the stylesheet is scoped under it so sibling previews don't bleed.
  host.className = opts.scopeClass ? `tscaps-live ${opts.scopeClass}` : 'tscaps-live';
  container.appendChild(host);

  // Scope the template CSS exactly like tscaps's
  // TemplatePreviewArtifactsBuilder.buildScopedCss: run it through CssScoper
  // (renames @keyframes per scope, prefixes selectors) and append the
  // !important paused rule for ::before/::after pseudos so template pseudo
  // animations stay frozen on the resting/scrubbed frame.
  let cssToInject = fullCssResolved;
  if (opts.scopeClass) {
    const scoper = new CssScoper();
    const scoped = scoper.scope(fullCssResolved, '.' + opts.scopeClass);
    const pseudoPause = `.${opts.scopeClass} *::before, .${opts.scopeClass} *::after { animation-play-state: paused !important; animation-fill-mode: both; }`;
    cssToInject = scoped + '\n' + pseudoPause;
  }
  const styleEl = document.createElement('style');
  styleEl.textContent = LIVE_BASELINE_CSS + '\n' + cssToInject;
  host.appendChild(styleEl);

  const segments = doc.getSegments();
  const duration = segments.reduce((m: number, s: any) => Math.max(m, s.time.end), 1) + 0.2;
  const align = opts.alignment ?? DEFAULT_ALIGNMENT;

  type WordRef = { w: any; el: HTMLElement; indexInLine: number };
  type LineRef = { line: any; el: HTMLElement };
  const built: { seg: any; el: HTMLElement; idx: number; words: WordRef[]; lines: LineRef[] }[] = [];

  segments.forEach((seg: any, idx: number) => {
    const segEl = document.createElement('div');
    segEl.className = 'segment';
    // Engine-faithful anchor: a 0×0 grid places the (max-content) wrapper at
    // the alignment point. `.segment` keeps its own template CSS
    // (display/position/transform) intact, so window-chrome / slide /
    // relative templates preview 1:1 with the exported frame.
    const { anchor, wrapper } = applyLiveAlignment(align);
    // Seed static inline CSS variables (outline / colors / font overrides)
    // on the wrapper — mirrors the engine's composeWrapperStyle (root vars
    // live on the wrapper; per-frame timing vars go on .segment in seek()).
    for (const [k, v] of Object.entries(inline)) wrapper.style.setProperty(k, v);
    // For sharp outline we apply the feMorphology SVG filter directly to
    // .segment (preview-only). flat keeps the centered stroke as-is.
    if (outlineFilterId) segEl.style.filter = `url(#${outlineFilterId})`;
    // Karaoke timing variables are applied per-frame in seek(); the engine
    // freezes each CSS animation at the current playback position by pausing
    // it with fill-mode:both (mirrors InlineStyleEmitter.serializeAnimatedVars).
    segEl.style.animationPlayState = 'paused';
    segEl.style.animationFillMode = 'both';
    wrapper.appendChild(segEl);
    host.appendChild(anchor);
    const words: WordRef[] = [];
    const lines: LineRef[] = [];
    let indexInLine = 0;
    for (const line of seg.lines) {
      const lineEl = document.createElement('div');
      lineEl.className = 'line';
      lineEl.style.animationPlayState = 'paused';
      lineEl.style.animationFillMode = 'both';
      for (const w of line.words) {
        const span = document.createElement('span');
        span.className = 'word';
        span.style.animationPlayState = 'paused';
        span.style.animationFillMode = 'both';
        // Per-letter animation (tscaps LetterAnimationStyleBuilder): expose the
        // letter count on the word and the index on each letter span so
        // templates can stagger keyframes via var(--letter-index).
        if (opts.splitWordsIntoLetters) {
          const letters = new GraphemeWordSplitter().split(w.displayText);
          span.style.setProperty(CssVariable.LETTER_COUNT, String(letters.length));
          for (let i = 0; i < letters.length; i++) {
            const ls = document.createElement('span');
            ls.className = 'letter';
            ls.style.animationPlayState = 'paused';
            ls.style.animationFillMode = 'both';
            ls.style.setProperty(CssVariable.LETTER_INDEX, String(i));
            ls.textContent = letters[i];
            span.appendChild(ls);
          }
        } else {
          span.textContent = w.displayText;
        }
        lineEl.appendChild(span);
        lineEl.appendChild(document.createTextNode(' '));
        words.push({ w, el: span, indexInLine });
        indexInLine++;
      }
      segEl.appendChild(lineEl);
      lines.push({ line, el: lineEl });
    }
    built.push({ seg, el: segEl, idx, words, lines });
  });

  // Append the outline SVG <defs> (built above) to the live host now that the
  // host exists, and RE-MEASURE the outline radius. feMorphology's radius is
  // in filter user units (px relative to the filtered element). We seeded it
  // with the em value; correct it to outline(em) × fontPx so the visible
  // stroke thickness is exactly `outline` em at this resolution. Read the
  // computed font-size off the first .word (or .segment) after layout.
  if (outlineSvg && outlineFilterId) {
    host.appendChild(outlineSvg);
    const ow = Math.max(0, parseFloat(String(opts.outline)) || 0);
    let fontPx = 0;
    const probe = built[0]?.words[0]?.el || built[0]?.el;
    if (probe) {
      const cs = getComputedStyle(probe);
      fontPx = parseFloat(cs.fontSize) || 0;
    }
    if (fontPx > 0 && ow > 0) {
      const radiusPx = ow * fontPx;
      const fm = outlineSvg.querySelector('feMorphology');
      if (fm) fm.setAttribute('radius', String(radiusPx));
    }
  }

  function setVars(el: HTMLElement, vars: Record<string, string>): void {
    for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
  }

  // Fonts may still be loading when we build; re-apply once they're ready so
  // the computed font-family on .word resolves to the embedded face.
  if (typeof document !== 'undefined' && (document as any).fonts?.ready) {
    (document as any).fonts.ready.then(() => {
      for (const b of built) {
        // Force a style recompute by toggling a no-op property.
        b.el.style.opacity = '1';
      }
    }).catch(() => {});
  }

  function seek(t: number): void {
    for (const b of built) {
      const active = t >= b.seg.time.start && t <= b.seg.time.end;
      b.el.style.display = active ? '' : 'none';
      if (!active) continue;
      const segClasses = b.seg.getCssClasses(t).filter((c: string) => c !== 'segment');
      b.el.className = 'segment ' + segClasses.join(' ');
      // Engine timing variables (event timestamps relative to currentTime)
      // drive the template's @keyframes; updating them each frame scrubs the
      // paused animation to the right progress → smooth karaoke sweep.
      setVars(b.el, b.seg.getCssVariables(t, { indexInSection: b.idx }));
      for (const lr of b.lines) {
        lr.el.className = 'line ' + lr.line.getCssClasses(t).filter((c: string) => c !== 'line').join(' ');
        setVars(lr.el, lr.line.getCssVariables(t, { segTime: b.seg.time }));
      }
      for (const wr of b.words) {
        wr.el.className = wr.w.getCssClasses(t).join(' ');
        setVars(wr.el, wr.w.getCssVariables(t, { segTime: b.seg.time, indexInLine: wr.indexInLine }));
        // The .word's font-family resolves through the inherited
        // --tscaps-font-family CSS variable. If the web font finished loading
        // AFTER this element was first laid out, Chromium may have cached the
        // *fallback* (system) font and won't re-resolve the var until the
        // element is forced to recompute styles. Re-applying the same
        // font-family string flushes that cached fallback and picks up the
        // now-ready embedded face.
        const fam = wr.el.style.fontFamily;
        wr.el.style.fontFamily = 'var(--tscaps-font-family, ' + (fam || 'system-ui') + ')';
      }
    }
  }

  seek(0);
  return {
    duration,
    seek,
    dispose() {
      if (outlineSvg) outlineSvg.remove();
      container.innerHTML = '';
    },
  };
}
