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

                // Helper: get widget value
                const getVal = (name) => {
                    const w = this.widgets?.find(w => w.name === name);
                    return w ? w.value : null;
                };

                // Color picker widgets
                const colorFields = [
                    { name: "font_color", label: "Font", def: "#FFFFFF" },
                    { name: "stroke_color", label: "Stroke", def: "#000000" },
                    { name: "highlight_color", label: "Highlight", def: "#ff0050" }
                ];

                colorFields.forEach(({ name, label, def }) => {
                    const row = document.createElement("div");
                    Object.assign(row.style, { display: "flex", alignItems: "center", gap: "6px", marginTop: "4px" });

                    const lbl = document.createElement("span");
                    lbl.textContent = label + ": ";
                    lbl.style.cssText = "color:#aaa;font-size:11px;width:60px;";

                    const colorBtn = document.createElement("input");
                    colorBtn.type = "color";
                    colorBtn.value = getVal(name) || def;
                    colorBtn.style.cssText = "width:28px;height:22px;border:1px solid #555;border-radius:4px;cursor:pointer;background:transparent;padding:0;";

                    const textInput = document.createElement("input");
                    textInput.type = "text";
                    textInput.value = colorBtn.value;
                    textInput.style.cssText = "width:70px;background:#222;color:#fff;border:1px solid #555;border-radius:4px;padding:2px 4px;font-size:11px;font-family:monospace;";

                    colorBtn.addEventListener("input", () => {
                        textInput.value = colorBtn.value;
                        const w = this.widgets?.find(w => w.name === name);
                        if (w) w.value = colorBtn.value;
                        renderLive();
                    });

                    textInput.addEventListener("change", () => {
                        if (/^#[0-9a-f]{6}$/i.test(textInput.value)) {
                            colorBtn.value = textInput.value;
                            const w = this.widgets?.find(w => w.name === name);
                            if (w) w.value = textInput.value;
                            renderLive();
                        }
                    });

                    row.appendChild(lbl);
                    row.appendChild(colorBtn);
                    row.appendChild(textInput);
                    previewNode.parentNode?.insertBefore(row, previewNode);
                });

                const renderLive = () => {
                    if (!this.takumiPreviewEl) return;

                    const data = {
                        text: getVal("text") || "Wah, gila banget nih!\nRender real-time pakai WASM\nGaya TikTok kekinian",
                        font_size: getVal("font_size") || 48,
                        font_color: getVal("font_color") || "#FFFFFF",
                        stroke_color: getVal("stroke_color") || "#000000",
                        stroke_width: getVal("stroke_width") || 4,
                        width: getVal("width") || 1080,
                        height: getVal("height") || 1920,
                        highlight_color: getVal("highlight_color") || "#ff0050"
                    };

                    // Sesuaikan rasio canvas preview
                    const containerRatio = data.width / data.height;
                    if (containerRatio >= 1) {
                        previewNode.style.minHeight = "200px";
                        captionEl.style.aspectRatio = data.width + "/" + data.height;
                    } else {
                        previewNode.style.minHeight = "300px";
                        captionEl.style.aspectRatio = data.width + "/" + data.height;
                    }
                    captionEl.style.width = "100%";
                    captionEl.style.height = "auto";

                    if (wasmReady && takumiRenderer && fontLoaded) {
                        try {
                            const W = data.width;
                            const H = data.height;
                            const lines = data.text.split('\n');

                            const makeTextChildren = (lineArr, color) => {
                                return lineArr.map((line, i) => {
                                    if (i === 0 && line.includes(' ')) {
                                        const parts = line.split(' ');
                                        const first = parts.shift();
                                        return {
                                            type: "container",
                                            style: { display: "flex", flexDirection: "row", gap: "10px" },
                                            children: [
                                                { type: "text", style: { color: color }, text: first },
                                                { type: "text", style: { color: color }, text: parts.join(' ') }
                                            ]
                                        };
                                    }
                                    return { type: "text", style: { color: color }, text: line };
                                });
                            };

                            const baseStyle = {
                                display: "flex", flexDirection: "column",
                                alignItems: "center", justifyContent: "center",
                                width: "100%", height: "100%",
                                fontFamily: "'Inter', sans-serif",
                                fontSize: data.font_size + "px",
                                fontWeight: "bold", textTransform: "uppercase",
                            };

                            // SVG 1: Stroke only (hitam, dengan WebkitTextStroke)
                            const strokeAST = {
                                type: "container",
                                style: { ...baseStyle, color: data.stroke_color, WebkitTextStrokeWidth: data.stroke_width + "px", WebkitTextStrokeColor: data.stroke_color },
                                children: makeTextChildren(lines, data.stroke_color)
                            };
                            const strokeSvg = takumiRenderer.renderSvg(strokeAST, { width: W, height: H });

                            // SVG 2: Fill only (putih/highlight, tanpa stroke)
                            const fillChildren = lines.map((line, i) => {
                                if (i === 0 && line.includes(' ')) {
                                    const parts = line.split(' ');
                                    const first = parts.shift();
                                    return {
                                        type: "container",
                                        style: { display: "flex", flexDirection: "row", gap: "10px" },
                                        children: [
                                            { type: "text", style: { color: data.highlight_color }, text: first },
                                            { type: "text", style: { color: data.font_color }, text: parts.join(' ') }
                                        ]
                                    };
                                }
                                return { type: "text", style: { color: data.font_color }, text: line };
                            });

                            const fillAST = {
                                type: "container",
                                style: { ...baseStyle, color: data.font_color },
                                children: fillChildren
                            };
                            const fillSvg = takumiRenderer.renderSvg(fillAST, { width: W, height: H });

                            // Composite: stroke SVG di belakang, fill SVG di depan
                            this.takumiPreviewEl.innerHTML = `
                                <div style="position:relative;width:100%;height:100%;">
                                    <div style="position:absolute;top:0;left:0;width:100%;height:100%;z-index:1;">${strokeSvg}</div>
                                    <div style="position:absolute;top:0;left:0;width:100%;height:100%;z-index:2;">${fillSvg}</div>
                                </div>
                            `;

                            const svgs = this.takumiPreviewEl.querySelectorAll("svg");
                            svgs.forEach(svg => {
                                svg.style.width = "100%";
                                svg.style.height = "100%";
                                svg.style.objectFit = "contain";
                            });

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
