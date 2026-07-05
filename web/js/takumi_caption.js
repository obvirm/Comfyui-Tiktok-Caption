import { app } from "/scripts/app.js";
import init, { Renderer } from "./takumi_wasm.js";

let wasmReady = false;
let takumiRenderer = null;
let fontLoaded = false;

async function loadWasm() {
    try {
        await init(new URL("./takumi_wasm_bg.wasm", import.meta.url));
        console.log("[Takumi WASM] Engine initialized.");
        takumiRenderer = new Renderer();

        try {
            const resp = await fetch("https://fonts.gstatic.com/s/inter/v18/UcCO3FwrK3iLTeHuS_nVMrMxCp50SjIw2boKoduKmMEVuLyfAZ9hiJ-Ek-_EeA.woff2");
            if (resp.ok) {
                const buf = await resp.arrayBuffer();
                takumiRenderer.registerFont(new Uint8Array(buf));
                console.log("[Takumi WASM] Font registered.");
                fontLoaded = true;
            }
        } catch (fe) {
            console.warn("[Takumi WASM] Font CDN unavailable:", fe);
        }

        wasmReady = true;
    } catch (err) {
        console.error("[Takumi WASM] Failed:", err);
    }
}

loadWasm();

app.registerExtension({
    name: "Comfy.TakumiCaption",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "TakumiCaptionNode") {
            const onNodeCreated = nodeType.prototype.onNodeCreated;
            nodeType.prototype.onNodeCreated = function () {
                const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;

                const previewNode = document.createElement("div");
                Object.assign(previewNode.style, {
                    width: "100%",
                    minHeight: "300px",
                    backgroundColor: "#1a1a1a",
                    position: "relative",
                    overflow: "hidden",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: "8px",
                    marginTop: "10px",
                });

                const captionEl = document.createElement("div");
                Object.assign(captionEl.style, {
                    width: "100%",
                    height: "100%",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                });
                captionEl.innerHTML = "<div style='color:#666;font-size:12px;font-family:sans-serif;'>TAKUMI WASM LOADING...</div>";
                previewNode.appendChild(captionEl);

                this.addDOMWidget("TAKUMI_PREVIEW", "preview", previewNode, { serialize: false, hideOnZoom: false });
                this.takumiPreviewEl = captionEl;

                const renderLive = () => {
                    if (!this.takumiPreviewEl) return;

                    const val = (name) => {
                        const w = this.widgets?.find(w => w.name === name);
                        return w ? w.value : null;
                    };

                    const data = {
                        text: val("text") || "Wah, gila banget nih!\nRender real-time pakai WASM\nGaya TikTok kekinian",
                        font_size: val("font_size") || 48,
                        font_color: val("font_color") || "#FFFFFF",
                        stroke_color: val("stroke_color") || "#000000",
                        stroke_width: val("stroke_width") || 4,
                        highlight_color: val("highlight_color") || "#ff0050"
                    };

                    if (wasmReady && fontLoaded) {
                        try {
                            const W = 1080, H = 1920;
                            const canvas = document.createElement("canvas");
                            canvas.width = W;
                            canvas.height = H;
                            const ctx = canvas.getContext("2d");

                            ctx.clearRect(0, 0, W, H);

                            const fontStr = `bold ${data.font_size}px 'Inter', sans-serif`;
                            ctx.font = fontStr;
                            ctx.textAlign = "center";
                            ctx.textBaseline = "middle";
                            ctx.textTransform = "uppercase";

                            const lines = data.text.toUpperCase().split('\n');
                            const lineHeight = data.font_size * 1.2;
                            const totalHeight = lines.length * lineHeight;
                            const startY = (H - totalHeight) / 2 + lineHeight / 2;

                            lines.forEach((line, i) => {
                                const y = startY + i * lineHeight;

                                if (i === 0 && line.includes(' ')) {
                                    // Highlight first word
                                    const parts = line.split(' ');
                                    const first = parts.shift();
                                    const rest = parts.join(' ');

                                    // Measure widths
                                    const firstWidth = ctx.measureText(first).width;
                                    const spaceWidth = ctx.measureText(' ').width;
                                    const restWidth = ctx.measureText(rest).width;
                                    const totalWidth = firstWidth + spaceWidth + restWidth;
                                    const startX = (W - totalWidth) / 2;

                                    // Draw first word (highlight)
                                    drawTikTokText(ctx, first, startX + firstWidth / 2, y, data.highlight_color, data.stroke_color, data.stroke_width);

                                    // Draw rest (white)
                                    drawTikTokText(ctx, rest, startX + firstWidth + spaceWidth + restWidth / 2, y, data.font_color, data.stroke_color, data.stroke_width);
                                } else {
                                    drawTikTokText(ctx, line, W / 2, y, data.font_color, data.stroke_color, data.stroke_width);
                                }
                            });

                            const img = document.createElement("img");
                            img.src = canvas.toDataURL("image/png");
                            img.style.width = "100%";
                            img.style.height = "100%";
                            img.style.objectFit = "contain";

                            this.takumiPreviewEl.innerHTML = "";
                            this.takumiPreviewEl.appendChild(img);

                        } catch (e) {
                            console.error("[Takumi WASM] Render error:", e);
                            this.takumiPreviewEl.innerHTML = "<div style='color:red;font-size:12px;font-family:monospace;'>WASM ERROR:<br/>" + String(e) + "</div>";
                        }
                    } else {
                        this.takumiPreviewEl.innerHTML = "<div style='color:orange;font-size:12px;font-family:monospace;'>Takumi WASM offline.</div>";
                    }
                };

                setTimeout(() => {
                    if (this.widgets) {
                        for (const w of this.widgets) {
                            const origCallback = w.callback;
                            w.callback = function() {
                                if (origCallback) origCallback.apply(this, arguments);
                                renderLive();
                            };
                        }
                        renderLive();
                    }
                }, 100);

                return r;
            };
        }
    },
});

function drawTikTokText(ctx, text, x, y, fillColor, strokeColor, strokeWidth) {
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    // Stroke (outline) - dilukis DULU = di BELAKANG fill = outline di LUAR
    if (strokeWidth > 0) {
        ctx.strokeStyle = strokeColor;
        ctx.lineWidth = strokeWidth * 2;
        ctx.lineJoin = "round";
        ctx.miterLimit = 2;
        ctx.strokeText(text, x, y);
    }

    // Fill (font color) - dilukis SETELAH = di ATAS stroke
    ctx.fillStyle = fillColor;
    ctx.fillText(text, x, y);

    ctx.restore();
}
