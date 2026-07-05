/* tslint:disable */
/* eslint-disable */
import type { Node } from "@takumi-rs/helpers";
import type { Properties } from "csstype";

export { ContainerNode, ImageNode, Node, NodeMetadata, TextNode } from "@takumi-rs/helpers";

export type ByteBuf = Uint8Array | ArrayBuffer | Buffer;

export type KeyframesMap = Record<string, Record<string, Properties>>;
export type KeyframesRuleList = {
    name: string;
    keyframes: {
        offsets: number[];
        declarations: Record<string, Properties>;
    }[];
}[];
export type Keyframes = KeyframesMap | KeyframesRuleList;

/** Output format for static images. */
export type OutputFormat = "png" | "jpeg" | "webp" | "ico" | "raw";

/** Output format for animated images. */
export type AnimationOutputFormat = "webp" | "apng" | "gif";

/** The output dithering algorithm. */
export type DitheringAlgorithm = "none" | "ordered-bayer" | "floyd-steinberg";

/** Cache policy for a decoded image. Defaults to `"auto"`. */
export type ImageCacheMode = "auto" | "none";

export type RenderOptions = {
    /**
     * The width of the image. If not provided, the width will be automatically calculated based on the content.
     */
    width?: number;
    /**
     * The height of the image. If not provided, the height will be automatically calculated based on the content.
     */
    height?: number;
    /**
     * The format of the image.
     * @default "png"
     */
    format?: OutputFormat;
    /**
     * The quality of lossy formats (0-100). For JPEG; on wasm, WebP is always
     * lossless so this is ignored for WebP.
     */
    quality?: number;
    /**
     * Encode WebP losslessly. On wasm, WebP is always lossless, so this is
     * accepted for parity with the native backend but has no effect.
     */
    lossless?: boolean;
    /**
     * Images keyed by `src`, each carrying raw bytes. Provided up front and used
     * in place of fetching external `src` URLs during rendering.
     */
    images?: ImageSource[];
    /**
     * CSS stylesheets to apply before rendering.
     */
    stylesheets?: string[];
    /**
     * Structured keyframes to register alongside stylesheets.
     */
    keyframes?: Keyframes;
    /**
     * Whether to draw debug borders.
     */
    drawDebugBorder?: boolean;
    /**
     * Defines the ratio resolution of the image to the physical pixels.
     * @default 1.0
     */
    devicePixelRatio?: number;
    /**
     * The animation timeline time in milliseconds.
     */
    timeMs?: number;
    /**
     * The output dithering algorithm.
     * @default "none"
     */
    dithering?: DitheringAlgorithm;
    /**
     * Per-render font stack: ordered family names used as the fallback chain.
     * Defaults to all registered families in registration order.
     */
    fontFamilies?: string[];
    /** Default BCP-47 language applied to the root, inherited by nodes without their own lang. */
    lang?: string;
};

/**
 * SVG is a vector format, so the raster-only knobs do not apply.
 */
export type SvgRenderOptions = Omit<
RenderOptions,
"format" | "quality" | "lossless" | "drawDebugBorder" | "devicePixelRatio" | "dithering"
>;

export type RenderAnimationOptions = {
    scenes: AnimationScene[];
    width: number;
    height: number;
    format?: AnimationOutputFormat;
    /**
     * The quality of lossy WebP (0-100). Ignored for APNG and GIF; on wasm, WebP
     * is always lossless so this is ignored for WebP too.
     */
    quality?: number;
    /**
     * Encode WebP losslessly. On wasm, animated WebP is always lossless, so this
     * is accepted for parity with the native backend but has no effect.
     */
    lossless?: boolean;
    /**
     * Images keyed by `src`, each carrying raw bytes. Provided up front and used
     * in place of fetching external `src` URLs during rendering.
     */
    images?: ImageSource[];
    drawDebugBorder?: boolean;
    /**
     * CSS stylesheets to apply before rendering.
     */
    stylesheets?: string[];
    /**
     * Structured keyframes to register alongside stylesheets.
     */
    keyframes?: Keyframes;
    /**
     * Defines the ratio resolution of the image to the physical pixels.
     * @default 1.0
     */
    devicePixelRatio?: number;
    /**
     * Frames per second for timeline sampling.
     */
    fps: number;
    /**
     * Per-render font stack: ordered family names used as the fallback chain.
     * Defaults to all registered families in registration order.
     */
    fontFamilies?: string[];
    /** Default BCP-47 language applied to the root, inherited by nodes without their own lang. */
    lang?: string;
};

export type FontDetails = {
    name?: string;
    data: ByteBuf;
    weight?: number;
    style?: "normal" | "italic" | "oblique" | `oblique ${number}deg` | (string & {});
    /**
     * Logical family this font is a coverage subset of. Subsets sharing a `subsetOf` are
     * kept as distinct families and `font-family: {subsetOf}` expands to all of them, so each
     * script routes to the subset that covers it. Set by {@link loadGoogleFonts}.
     */
    subsetOf?: string;
};

export type ImageSource = {
    src: string;
    data: ByteBuf;
    /** Cache policy for the decoded image. Defaults to `"auto"`. */
    cache?: ImageCacheMode;
};

export type KeyframeRule = {
    offsets: number[];
    declarations: Record<string, Properties>;
};

export type KeyframesRule = {
    name: string;
    keyframes: KeyframeRule[];
};

export type Font = FontDetails | ByteBuf;

export type RegisteredFace = {
    weight: number;
    style: string;
    width: number;
    index: number;
};

export type RegisteredFamily = {
    name: string;
    faces: RegisteredFace[];
};

export type MeasuredTextRun = {
    text: string;
    x: number;
    y: number;
    width: number;
    height: number;
};

export type MeasuredNode = {
    width: number;
    height: number;
    transform: [number, number, number, number, number, number];
    children: MeasuredNode[];
    runs: MeasuredTextRun[];
};

export type AnimationScene = {
    node: Node;
    durationMs: number;
};



/**
 * The main renderer for Takumi image rendering engine.
 *
 * State lives behind a lock and every method takes `&self`, mirroring the
 * napi bindings: a panic mid-call can't leave the wasm-bindgen borrow flag
 * permanently set, which would otherwise fail all subsequent calls.
 */
export class Renderer {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Measures a node tree and returns layout information.
     */
    measure(node: Node, options?: RenderOptions | null): MeasuredNode;
    /**
     * Creates a new Renderer instance.
     */
    constructor();
    /**
     * Registers fonts into the renderer, returning the families each font produced.
     */
    registerFont(font: Font): RegisteredFamily[];
    /**
     * Renders a node tree into an image buffer.
     */
    render(node: Node, options?: RenderOptions | null): Uint8Array;
    /**
     * Renders a sequential animation timeline into a buffer.
     */
    renderAnimation(options: RenderAnimationOptions): Uint8Array;
    /**
     * Renders a node tree into a data URL.
     *
     * `raw` format is not supported for data URL.
     */
    renderAsDataUrl(node: Node, options: RenderOptions): string;
    /**
     * Renders a node tree into an SVG document string.
     */
    renderSvg(node: Node, options?: SvgRenderOptions | null): string;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_renderer_free: (a: number, b: number) => void;
    readonly renderer_measure: (a: number, b: any, c: number) => [number, number, number];
    readonly renderer_new: () => [number, number, number];
    readonly renderer_registerFont: (a: number, b: any) => [number, number, number];
    readonly renderer_render: (a: number, b: any, c: number) => [number, number, number, number];
    readonly renderer_renderAnimation: (a: number, b: any) => [number, number, number, number];
    readonly renderer_renderAsDataUrl: (a: number, b: any, c: any) => [number, number, number, number];
    readonly renderer_renderSvg: (a: number, b: any, c: number) => [number, number, number, number];
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_exn_store: (a: number) => void;
    readonly __externref_table_alloc: () => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
