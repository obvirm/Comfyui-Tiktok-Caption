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
                    display: "flex",
                    flexDirection: "column",
                    gap: "6px",
                    marginTop: "10px",
                });

                // Color picker row
                const colorRow = document.createElement("div");
                Object.assign(colorRow.style, { display: "flex", gap: "8px", flexWrap: "wrap" });

                const colorFields = [
                    { name: "font_color", label: "Font", def: "#FFFFFF" },
                    { name: "stroke_color", label: "Stroke", def: "#000000" },
                    { name: "highlight_color", label: "Highlight", def: "#ff0050" },
                    { name: "shadow_color", label: "Shadow", def: "#000000" },
                    { name: "active_word_color", label: "Active", def: "#ff0050" },
                    { name: "active_glow_color", label: "Glow", def: "#ff0050" },
                    { name: "active_bg_color", label: "Bg", def: "transparent" }
                ];

                const colorBtns = {};
                colorFields.forEach(({ name, label, def }) => {
                    const field = document.createElement("div");
                    Object.assign(field.style, { display: "flex", alignItems: "center", gap: "4px" });

                    const lbl = document.createElement("span");
                    lbl.textContent = label;
                    lbl.style.cssText = "color:#aaa;font-size:10px;";

                    const colorBtn = document.createElement("input");
                    colorBtn.type = "color";
                    colorBtn.value = def === "transparent" ? "#000000" : def;
                    colorBtn.style.cssText = "width:24px;height:20px;border:1px solid #555;border-radius:3px;cursor:pointer;background:transparent;padding:0;";

                    const hexInput = document.createElement("input");
                    hexInput.type = "text";
                    hexInput.value = def;
                    hexInput.style.cssText = "width:60px;background:#222;color:#fff;border:1px solid #555;border-radius:3px;padding:1px 3px;font-size:9px;font-family:monospace;";

                    colorBtn.addEventListener("input", () => {
                        hexInput.value = colorBtn.value;
                        const w = this.widgets?.find(w => w.name === name);
                        if (w) w.value = colorBtn.value;
                        renderLive();
                    });

                    hexInput.addEventListener("change", () => {
                        const v = hexInput.value.trim();
                        if (v === "transparent" || /^#[0-9a-f]{6}$/i.test(v)) {
                            if (v !== "transparent") colorBtn.value = v;
                            const w = this.widgets?.find(w => w.name === name);
                            if (w) w.value = v;
                            renderLive();
                        }
                    });

                    colorBtns[name] = colorBtn;
                    field.appendChild(lbl);
                    field.appendChild(colorBtn);
                    field.appendChild(hexInput);
                    colorRow.appendChild(field);
                });

                previewNode.appendChild(colorRow);

                // Canvas container
                const canvasContainer = document.createElement("div");
                Object.assign(canvasContainer.style, {
                    width: "100%",
                    minHeight: "300px",
                    backgroundColor: "#1a1a1a",
                    position: "relative",
                    overflow: "hidden",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: "8px",
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
                canvasContainer.appendChild(captionEl);
                previewNode.appendChild(canvasContainer);

                this.addDOMWidget("TAKUMI_PREVIEW", "preview", previewNode, { serialize: false, hideOnZoom: false });
                this.takumiPreviewEl = captionEl;

                const renderLive = () => {
                    if (!this.takumiPreviewEl) return;

                    const getVal = (name) => {
                        const w = this.widgets?.find(w => w.name === name);
                        return w ? w.value : null;
                    };

                    const data = {
                        text: getVal("text") || "Wah, gila banget nih!\nRender real-time pakai WASM\nGaya TikTok kekinian",
                        font_family: getVal("font_family") || "Inter, sans-serif",
                        font_size: getVal("font_size") || 48,
                        letter_spacing: getVal("letter_spacing") || 0,
                        line_height: getVal("line_height") || 1.2,
                        max_words_per_line: getVal("max_words_per_line") || 0,
                        max_lines_per_page: getVal("max_lines_per_page") || 0,
                        font_size: getVal("font_size") || 48,
                        font_color: getVal("font_color") || "#FFFFFF",
                        stroke_color: getVal("stroke_color") || "#000000",
                        stroke_width: getVal("stroke_width") || 4,
                        width: getVal("width") || 1080,
                        height: getVal("height") || 1920,
                        shadow_color: getVal("shadow_color") || "#000000",
                        position_x: getVal("position_x") || 0,
                        position_y: getVal("position_y") || 0,
                        vertical_align: getVal("vertical_align") || "center",
                        alignment: getVal("alignment") || "center",
                        shadow_blur: getVal("shadow_blur") || 0,
                        shadow_offset_x: getVal("shadow_offset_x") || 2,
                        shadow_offset_y: getVal("shadow_offset_y") || 2,
                        highlight_color: getVal("highlight_color") || "#ff0050",
                        word_pop: getVal("word_pop") || false,
                        bounce: getVal("bounce") || false,
                        scale_in: getVal("scale_in") || false,
                        fade_in: getVal("fade_in") || false,
                        active_word_color: getVal("active_word_color") || "#ff0050",
                        active_glow_color: getVal("active_glow_color") || "#ff0050",
                        active_glow_intensity: getVal("active_glow_intensity") || 0,
                        active_scale: getVal("active_scale") || 1.0,
                        active_rotation: getVal("active_rotation") || 0,
                        active_skew: getVal("active_skew") || 0,
                        active_bg_color: getVal("active_bg_color") || "transparent",
                        active_bg_radius: getVal("active_bg_radius") || 0,
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
                            // Wrap text based on max_words_per_line
                            let textToRender = data.text;
                            if (data.max_words_per_line > 0) {
                                const rawLines = data.text.split('\n');
                                const wrappedLines = [];
                                for (const line of rawLines) {
                                    const words = line.split(' ');
                                    if (words.length > data.max_words_per_line) {
                                        for (let i = 0; i < words.length; i += data.max_words_per_line) {
                                            wrappedLines.push(words.slice(i, i + data.max_words_per_line).join(' '));
                                        }
                                    } else {
                                        wrappedLines.push(line);
                                    }
                                }
                                textToRender = wrappedLines.join('\n');
                            }
                            if (data.max_lines_per_page > 0) {
                                textToRender = textToRender.split('\n').slice(0, data.max_lines_per_page).join('\n');
                            }
                            const lines = textToRender.split('\n');

                            const makeTextChildren = (lineArr, color, isFirstLineActive) => {
                                return lineArr.map((line, i) => {
                                    const words = line.split(' ');
                                    const wordNodes = words.map((word, j) => {
                                        const isActive = isFirstLineActive && i === 0 && j === 0;
                                        if (isActive) {
                                            // Active word: wrap in container with background
                                            const textStyle = {
                                                color: data.active_word_color,
                                                transform: `scale(${data.active_scale}) rotate(${data.active_rotation}deg) skewX(${data.active_skew}deg)`,
                                                filter: data.active_glow_intensity > 0 ? `drop-shadow(0 0 ${data.active_glow_intensity}px ${data.active_glow_color})` : "none",
                                            };
                                            const hasBg = data.active_bg_color !== "transparent";
                                            if (hasBg) {
                                                return {
                                                    type: "container",
                                                    style: {
                                                        backgroundColor: data.active_bg_color,
                                                        borderRadius: data.active_bg_radius + "px",
                                                        padding: "4px 10px",
                                                        display: "inline-flex",
                                                    },
                                                    children: [{ type: "text", style: textStyle, text: word }]
                                                };
                                            }
                                            return { type: "text", style: textStyle, text: word };
                                        }
                                        return { type: "text", style: { color: color }, text: word };
                                    });
                                    return {
                                        type: "container",
                                        style: { display: "flex", flexDirection: "row", flexWrap: "wrap", gap: "8px", justifyContent: "inherit" },
                                        children: wordNodes
                                    };
                                });
                            };

                            const valignMap = { "top": "flex-start", "center": "center", "bottom": "flex-end" };
                            const alignMap = { "left": "flex-start", "center": "center", "right": "flex-end" };
                            const textAlignMap = { "left": "left", "center": "center", "right": "right" };

                            const baseStyle = {
                                display: "flex", flexDirection: "column",
                                alignItems: alignMap[data.alignment] || "center",
                                justifyContent: valignMap[data.vertical_align] || "center",
                                width: "100%", height: "100%",
                                fontFamily: data.font_family,
                                fontSize: data.font_size + "px",
                                fontWeight: "bold", textTransform: "uppercase",
                                letterSpacing: data.letter_spacing + "px",
                                lineHeight: data.line_height,
                                textAlign: textAlignMap[data.alignment] || "center",
                            };

                            // SVG 1: Stroke only (hitam, dengan WebkitTextStroke)
                            const strokeAST = {
                                type: "container",
                                style: { ...baseStyle, color: data.stroke_color, WebkitTextStrokeWidth: data.stroke_width + "px", WebkitTextStrokeColor: data.stroke_color },
                                children: makeTextChildren(lines, data.stroke_color, false)
                            };
                            const strokeSvg = takumiRenderer.renderSvg(strokeAST, { width: W, height: H });

                            // SVG 2: Fill only (putih/highlight, tanpa stroke)
                            const fillChildren = lines.map((line, i) => {
                                const words = line.split(' ');
                                const wordNodes = words.map((word, j) => {
                                    const isActive = i === 0 && j === 0;
                                    if (isActive) {
                                        const textStyle = {
                                            color: data.active_word_color,
                                            transform: `scale(${data.active_scale}) rotate(${data.active_rotation}deg) skewX(${data.active_skew}deg)`,
                                            filter: data.active_glow_intensity > 0 ? `drop-shadow(0 0 ${data.active_glow_intensity}px ${data.active_glow_color})` : "none",
                                        };
                                        const hasBg = data.active_bg_color !== "transparent";
                                        if (hasBg) {
                                            return {
                                                type: "container",
                                                style: {
                                                    backgroundColor: data.active_bg_color,
                                                    borderRadius: data.active_bg_radius + "px",
                                                    padding: "4px 10px",
                                                    display: "inline-flex",
                                                },
                                                children: [{ type: "text", style: textStyle, text: word }]
                                            };
                                        }
                                        return { type: "text", style: textStyle, text: word };
                                    }
                                    return { type: "text", style: { color: data.font_color }, text: word };
                                });
                                return {
                                    type: "container",
                                    style: { display: "flex", flexDirection: "row", flexWrap: "wrap", gap: "8px", justifyContent: "inherit" },
                                    children: wordNodes
                                };
                            });

                            const fillAST = {
                                type: "container",
                                style: { ...baseStyle, color: data.font_color },
                                children: fillChildren
                            };
                            const fillSvg = takumiRenderer.renderSvg(fillAST, { width: W, height: H });

                            // SVG 3: Shadow
                            const shadowColor = data.shadow_color || "#000000";
                            const shadowAST = {
                                type: "container",
                                style: { ...baseStyle, color: shadowColor },
                                children: makeTextChildren(lines, shadowColor, false)
                            };
                            const shadowSvg = takumiRenderer.renderSvg(shadowAST, { width: W, height: H });

                            const sx = data.shadow_offset_x || 0;
                            const sy = data.shadow_offset_y || 0;
                            const sb = data.shadow_blur || 0;
                            const blurFilter = sb > 0 ? `filter:blur(${sb}px);` : "";

                            // SVG 4: Active Background (paling belakang, di belakang shadow)
                            let bgSvg = "";
                            if (data.active_bg_color !== "transparent") {
                                const firstLine = lines[0] || "";
                                const firstWord = firstLine.split(" ")[0] || "";
                                if (firstWord) {
                                    const bgAST = {
                                        type: "container",
                                        style: {
                                            ...baseStyle,
                                            color: "transparent",
                                        },
                                        children: [{
                                            type: "container",
                                            style: {
                                                backgroundColor: data.active_bg_color,
                                                borderRadius: data.active_bg_radius + "px",
                                                padding: "6px 14px",
                                                display: "inline-flex",
                                                alignSelf: baseStyle.alignItems,
                                                justifySelf: baseStyle.justifyContent,
                                            },
                                            children: [{ type: "text", style: { color: "transparent" }, text: firstWord }]
                                        }]
                                    };
                                    bgSvg = takumiRenderer.renderSvg(bgAST, { width: W, height: H });
                                }
                            }

                            // Build animation styles
                            let animStyle = "";
                            let fillAnim = "";
                            let strokeAnim = "";
                            let shadowAnim = "";

                            if (data.fade_in) {
                                animStyle += `@keyframes fadeIn { from { opacity:0; } to { opacity:1; } }`;
                                fillAnim += `animation: fadeIn 0.5s ease-out forwards;`;
                                strokeAnim += `animation: fadeIn 0.5s ease-out forwards;`;
                                shadowAnim += `animation: fadeIn 0.5s ease-out forwards;`;
                            }
                            if (data.scale_in) {
                                animStyle += `@keyframes scaleIn { from { transform:scale(0); } to { transform:scale(1); } }`;
                                fillAnim += `animation: scaleIn 0.4s cubic-bezier(0.34,1.56,0.64,1) forwards;`;
                                strokeAnim += `animation: scaleIn 0.4s cubic-bezier(0.34,1.56,0.64,1) forwards;`;
                                shadowAnim += `animation: scaleIn 0.4s cubic-bezier(0.34,1.56,0.64,1) forwards;`;
                            }
                            if (data.bounce) {
                                animStyle += `@keyframes bounce { 0%,100% { transform:translateY(0); } 50% { transform:translateY(-20px); } }`;
                                fillAnim += `animation: bounce 0.6s ease-in-out infinite;`;
                                strokeAnim += `animation: bounce 0.6s ease-in-out infinite;`;
                                shadowAnim += `animation: bounce 0.6s ease-in-out infinite;`;
                            }
                            if (data.word_pop) {
                                animStyle += `@keyframes wordPop { 0% { transform:scale(0) rotate(-10deg); opacity:0; } 60% { transform:scale(1.2) rotate(2deg); } 100% { transform:scale(1) rotate(0); opacity:1; } }`;
                                fillAnim += `animation: wordPop 0.3s cubic-bezier(0.34,1.56,0.64,1) forwards;`;
                                strokeAnim += `animation: wordPop 0.3s cubic-bezier(0.34,1.56,0.64,1) forwards;`;
                                shadowAnim += `animation: wordPop 0.3s cubic-bezier(0.34,1.56,0.64,1) forwards;`;
                            }

                            // Composite: shadow (paling belakang) -> stroke -> fill (paling depan)
                            const px = data.position_x || 0;
                            const py = data.position_y || 0;
                            this.takumiPreviewEl.innerHTML = `
                                <style>${animStyle}</style>
                                <div style="position:relative;width:100%;height:100%;transform:translate(${px}%,${py}%);">
                                    ${bgSvg ? `<div style="position:absolute;top:0;left:0;width:100%;height:100%;z-index:-1;">${bgSvg}</div>` : ""}
                                    <div style="position:absolute;top:0;left:0;width:100%;height:100%;z-index:0;transform:translate(${sx}px,${sy}px);${blurFilter}${shadowAnim}">${shadowSvg}</div>
                                    <div style="position:absolute;top:0;left:0;width:100%;height:100%;z-index:1;${strokeAnim}">${strokeSvg}</div>
                                    <div style="position:absolute;top:0;left:0;width:100%;height:100%;z-index:2;${fillAnim}">${fillSvg}</div>
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

                // Wire up color picker event listeners
                Object.keys(colorBtns).forEach(name => {
                    colorBtns[name].addEventListener("input", () => {
                        const w = this.widgets?.find(w => w.name === name);
                        if (w) w.value = colorBtns[name].value;
                        renderLive();
                    });
                });

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
