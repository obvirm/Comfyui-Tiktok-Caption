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
} from './tscaps_bridge';
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
  return await tr.transcribe(new Blob(), {});
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
      splitWordsIntoLetters: false,
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
  const doc = await srtToDocument(params.srt);
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
  const doc = await srtToDocument(params.srt);
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
  const doc = await srtToDocument(params.srt);
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
(window as any).TikTokCaption = { renderCaptionFrame, renderCaptionFrames, renderCaptionFramesToBitmaps, srtToDocument };
