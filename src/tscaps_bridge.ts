// Bridge to vendored tscaps engine source (browser-only, no Whisper/mediabunny).
// esbuild resolves @modules/* via --alias.
import { BrowserSubtitleFrameRenderer } from '@modules/rendering/BrowserSubtitleFrameRenderer';
import { BrowserCssResourceEmbedder } from '@modules/css/BrowserCssResourceEmbedder';
import { GraphemeWordSplitter } from '@modules/splitting/GraphemeWordSplitter';
import { SrtTranscriber } from '@modules/transcription/SrtTranscriber';
import { Document } from '@modules/document/Document';
import { StructureTagger } from '@modules/tagging/StructureTagger';

export {
  BrowserSubtitleFrameRenderer,
  BrowserCssResourceEmbedder,
  GraphemeWordSplitter,
  SrtTranscriber,
  Document,
  StructureTagger,
};

export function createRenderer(embedder: any, splitter: any): any {
  return BrowserSubtitleFrameRenderer.create(embedder, splitter);
}
