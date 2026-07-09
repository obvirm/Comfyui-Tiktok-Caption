// Bridge to vendored tscaps engine source (browser-only, no Whisper/mediabunny).
// esbuild resolves @modules/* via --alias.
import { BrowserSubtitleFrameRenderer } from '@modules/rendering/BrowserSubtitleFrameRenderer';
import { BrowserCssResourceEmbedder } from '@modules/css/BrowserCssResourceEmbedder';
import { GraphemeWordSplitter } from '@modules/splitting/GraphemeWordSplitter';
import { SrtTranscriber } from '@modules/transcription/SrtTranscriber';
import { Document } from '@modules/document/Document';

export {
  BrowserSubtitleFrameRenderer,
  BrowserCssResourceEmbedder,
  GraphemeWordSplitter,
  SrtTranscriber,
  Document,
};

export function createRenderer(embedder: any, splitter: any): any {
  return BrowserSubtitleFrameRenderer.create(embedder, splitter);
}
