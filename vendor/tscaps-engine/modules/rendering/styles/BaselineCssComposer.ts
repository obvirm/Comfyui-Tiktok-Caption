import { DECORATION_CONTAINER_BASELINE_CSS } from '@modules/rendering/styles/DecorationContainerBaselineCss';
import { VIDEO_FRAME_LAYER_BASELINE_CSS } from '@modules/rendering/styles/VideoFrameLayerClass';

/**
 * CSS that applies to every rendered subtree regardless of which
 * baseline blocks the style opts into. Keep this minimal — every byte
 * here ships in every frame of every export.
 */
const UNIVERSAL_BASELINE_CSS = `html { font-size: 16px; text-rendering: geometricPrecision; -webkit-font-smoothing: antialiased; -webkit-text-size-adjust: 100%; }
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; animation-fill-mode: both; animation-play-state: paused !important; }
.line { white-space: nowrap; }
/* Safe minimum line spacing. Templates may override this, but if they omit
   line-height the value falls back to the font's "normal" — which is tight
   (sometimes < 1.0) for display fonts, causing adjacent caption lines to
   touch/overlap. A 1.3 floor guarantees a visible gap between lines. */
.segment { position: relative; line-height: 1.3; }`;

/**
 * Optional baseline CSS blocks a prepared style depends on. Each flag
 * gates a chunk of baseline CSS that would otherwise ship unused
 * bytes into every rendered SVG.
 */
export interface BaselineNeeds {
  readonly decorations: boolean;
  readonly videoFrame: boolean;
}

/**
 * Builds the baseline CSS string that prefixes a style's own rules.
 * Only the blocks the style declares it needs are appended, so a
 * decoration-free template doesn't carry the `.word-decoration` rules
 * and a template that ignores the video frame doesn't carry the
 * video-frame layer rule.
 */
export class BaselineCssComposer {

  compose(needs: BaselineNeeds): string {
    let css = UNIVERSAL_BASELINE_CSS;
    if (needs.decorations) css += '\n' + DECORATION_CONTAINER_BASELINE_CSS;
    if (needs.videoFrame) css += '\n' + VIDEO_FRAME_LAYER_BASELINE_CSS;
    return css;
  }

  /** Composes the union baseline across every needs entry in `perStyle`. */
  composeUnion(perStyle: ReadonlyArray<BaselineNeeds>): string {
    return this.compose({
      decorations: perStyle.some((n) => n.decorations),
      videoFrame: perStyle.some((n) => n.videoFrame),
    });
  }
}
