import { renderCaptionFrame, renderCaptionFrames } from './caption_render';

(window as any).renderCaptionFrame = renderCaptionFrame;
(window as any).renderCaptionFrames = renderCaptionFrames;
(window as any).runCaptionTest = async () => {
  const srt = `1
00:00:00,000 --> 00:00:02,000
Hello world

2
00:00:02,000 --> 00:00:04,000
Caption test`;
  const css = `.segment{font-family:system-ui,sans-serif;font-weight:800;font-size:8cqh;color:#fff;-webkit-text-stroke:0.05em #000;paint-order:stroke fill;text-align:center;line-height:1.2;}
.line{display:block;text-align:center;}
.word{display:inline-block;margin:0 0.15em;}`;
  const frames = await renderCaptionFrames({ srt, css, width: 540, height: 960 }, 10);
  console.log('[test] frames:', frames.length);
  return frames.length;
};
