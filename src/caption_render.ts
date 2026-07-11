/**
 * TikTok Caption — shared caption rendering API (browser-side).
 * Uses vendored tscaps engine: CSS-styled captions from SRT input.
 * Consumed by both the in-node preview (frontend) and the headless
 * final renderer (CloakBrowser) so preview === output (1:1).
 */
import { SrtTranscriber } from '@modules/transcription/SrtTranscriber';
// Polyfill crypto.randomUUID for headless Chromium contexts that lack it
try { if (typeof crypto !== 'undefined' && !crypto.randomUUID) {
  (crypto as any).randomUUID = () => 'id-' + Math.random().toString(16).slice(2);
} } catch {}
import {
  createRenderer,
  BrowserCssResourceEmbedder,
  GraphemeWordSplitter,
  StructureTagger,
} from './tscaps_bridge';
import { Document } from '@modules/document/Document';
import { Segment } from '@modules/document/Segment';
import { Line } from '@modules/document/Line';
import { TimeFragment } from '@modules/document/TimeFragment';
import type {
  SubtitleStyle,
  SubtitleFrameRenderer,
} from '@modules/rendering/SubtitleFrameRenderer';

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
  maxChars?: number;
  maxLines?: number;
  gapFree?: boolean;
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
 * Re-split segments that exceed maxChars by distributing words into
 * new segments while preserving timing (words keep their original time).
 */
function applyMaxChars(doc: Document, maxChars: number): Document {
  if (maxChars <= 0) return doc;
  const newSections = doc.sections.map((section: any) => {
    const newSegments: any[] = [];
    for (const seg of section.segments) {
      const words = seg.lines.flatMap((l: any) => [...l.words]);
      if (getTextLen(words) <= maxChars) {
        newSegments.push(seg);
        continue;
      }
      // Split words into chunks respecting maxChars
      let current: any[] = [];
      for (const w of words) {
        const candidate = [...current, w];
        if (current.length > 0 && getTextLen(candidate) > maxChars) {
          newSegments.push(makeSegment(current, seg.time.start, seg.time.end));
          current = [w];
        } else {
          current = candidate;
        }
      }
      if (current.length > 0) {
        newSegments.push(makeSegment(current, seg.time.start, seg.time.end));
      }
    }
    return section.with({ segments: newSegments });
  });
  const tagged = doc.with({ sections: newSections });
  return new StructureTagger().tag(tagged);
}

/** Get total character count of words (space-separated). */
function getTextLen(words: any[]): number {
  return words.reduce((sum, w) => sum + w.displayText.length, 0) + Math.max(0, words.length - 1);
}

/** Create a Segment from an array of words, preserving original segment timing. */
function makeSegment(words: any[], segStart: number, segEnd: number): any {
  const lines = words.map((w: any) => new Line({ words: [w] }));
  const time = new TimeFragment(segStart, segEnd);
  return new Segment({ lines, customTime: time });
}

/**
 * Re-split lines within each segment to respect maxLines.
 * Words beyond maxLines are pushed to additional lines.
 */
function applyMaxLines(doc: Document, maxLines: number): Document {
  if (maxLines <= 0) return doc;
  const newSections = doc.sections.map((section: any) => {
    const newSegments = section.segments.map((seg: any) => {
      const allWords = seg.lines.flatMap((l: any) => [...l.words]);
      if (seg.lines.length <= maxLines) return seg;
      // Re-distribute words into maxLines lines
      const lines: any[] = [];
      const perLine = Math.ceil(allWords.length / maxLines);
      for (let i = 0; i < allWords.length; i += perLine) {
        const chunk = allWords.slice(i, i + perLine);
        lines.push(new Line({ words: chunk }));
      }
      return seg.with({ lines });
    });
    return section.with({ segments: newSegments });
  });
  const tagged = doc.with({ sections: newSections });
  return new StructureTagger().tag(tagged);
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

function buildStyle(params: CaptionParams): Record<string, SubtitleStyle> {
  const style: SubtitleStyle = {
    css: params.css,
    inlineStyles: (params as any).inlineStyles ?? {},
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
  if (params.maxChars) doc = applyMaxChars(doc, params.maxChars);
  if (params.maxLines) doc = applyMaxLines(doc, params.maxLines);
  if (params.gapFree) doc = applyGapFree(doc);
  // text_case: add CSS text-transform to inlineStyles
  const inline = { ...(params.inlineStyles ?? {}) };
  if (params.textCase && params.textCase !== 'none') {
    inline['--tscaps-text-transform'] = params.textCase;
  }
  const styles = buildStyle({ ...params, inlineStyles: inline });
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
  if (params.maxChars) doc = applyMaxChars(doc, params.maxChars);
  if (params.maxLines) doc = applyMaxLines(doc, params.maxLines);
  if (params.gapFree) doc = applyGapFree(doc);
  const inline = { ...(params.inlineStyles ?? {}) };
  if (params.textCase && params.textCase !== 'none') {
    inline['--tscaps-text-transform'] = params.textCase;
  }
  const styles = buildStyle({ ...params, inlineStyles: inline });
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
  if (params.maxChars) doc = applyMaxChars(doc, params.maxChars);
  if (params.maxLines) doc = applyMaxLines(doc, params.maxLines);
  if (params.gapFree) doc = applyGapFree(doc);
  const inline = { ...(params.inlineStyles ?? {}) };
  if (params.textCase && params.textCase !== 'none') {
    inline['--tscaps-text-transform'] = params.textCase;
  }
  const styles = buildStyle({ ...params, inlineStyles: inline });
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
(window as any).TikTokCaption = { renderCaptionFrame, renderCaptionFrames, renderCaptionFramesToBitmaps, srtToDocument };
