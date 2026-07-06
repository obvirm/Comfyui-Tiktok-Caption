import os
import json
import torch
import numpy as np
import subprocess
import tempfile
from PIL import Image

class TakumiCaptionNode:
    @classmethod
    def INPUT_TYPES(s):
        return {
            "required": {
                "text": ("STRING", {"multiline": True, "default": "Wah, gila banget nih!\nRender real-time pakai WASM\nGaya TikTok kekinian"}),
                "font_family": ("STRING", {"default": "Inter, sans-serif"}),
                "font_size": ("INT", {"default": 48, "min": 10, "max": 200}),
                "letter_spacing": ("INT", {"default": 0, "min": -10, "max": 20, "step": 1}),
                "line_height": ("FLOAT", {"default": 1.2, "min": 0.5, "max": 3.0, "step": 0.1}),
                "max_words_per_line": ("INT", {"default": 0, "min": 0, "max": 50, "step": 1}),
                "max_lines_per_page": ("INT", {"default": 0, "min": 0, "max": 20, "step": 1}),
                "animation": (["None", "Word Pop", "Bounce", "Scale In", "Fade In"], {"default": "None"}),
                "font_color": ("STRING", {"default": "#FFFFFF"}),
                "stroke_color": ("STRING", {"default": "#000000"}),
                "stroke_width": ("INT", {"default": 4, "min": 0, "max": 20}),
                "width": ("INT", {"default": 1080, "min": 64, "max": 4096}),
                "height": ("INT", {"default": 1920, "min": 64, "max": 4096}),
                "shadow_color": ("STRING", {"default": "#000000"}),
                "shadow_blur": ("INT", {"default": 0, "min": 0, "max": 20, "step": 1}),
                "shadow_offset_x": ("INT", {"default": 2, "min": -20, "max": 20, "step": 1}),
                "shadow_offset_y": ("INT", {"default": 2, "min": -20, "max": 20, "step": 1}),
                "highlight_color": ("STRING", {"default": "#ff0050"}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "render_caption"
    CATEGORY = "image/text"

    def _build_takumi_ast(self, text, font_family, font_size, letter_spacing, line_height, font_color, stroke_color, stroke_width, highlight_color):
        """Membangun AST JSON murni sesuai spek struktur Takumi."""
        lines = text.split('\n')
        
        children = []
        for i, line in enumerate(lines):
            if i == 0 and " " in line:
                parts = line.split(' ')
                first = parts.pop(0)
                children.append({
                    "type": "container",
                    "style": { "display": "flex", "flexDirection": "row", "gap": "10px" },
                    "children": [
                        {"type": "text", "style": {"color": highlight_color}, "text": first},
                        {"type": "text", "text": " ".join(parts)}
                    ]
                })
            else:
                children.append({"type": "text", "text": line})

        return {
            "type": "container",
            "style": {
                "display": "flex",
                "flexDirection": "column",
                "alignItems": "center",
                "justifyContent": "center",
                "width": "100%",
                "height": "100%",
                "fontFamily": font_family,
                "fontSize": f"{font_size}px",
                "fontWeight": "bold",
                "letterSpacing": f"{letter_spacing}px",
                "lineHeight": str(line_height),
                "textTransform": "uppercase",
                "color": font_color,
                "WebkitTextStrokeWidth": f"{stroke_width}px",
                "WebkitTextStrokeColor": stroke_color,
                "backgroundColor": "transparent"
            },
            "children": children
        }

    def _wrap_text(self, text, max_words_per_line, max_lines_per_page):
        if max_words_per_line <= 0 and max_lines_per_page <= 0:
            return text
        lines = text.split('\n')
        result = []
        for line in lines:
            words = line.split(' ')
            if max_words_per_line > 0 and len(words) > max_words_per_line:
                chunks = []
                for i in range(0, len(words), max_words_per_line):
                    chunks.append(' '.join(words[i:i + max_words_per_line]))
                result.extend(chunks)
            else:
                result.append(line)
        if max_lines_per_page > 0 and len(result) > max_lines_per_page:
            result = result[:max_lines_per_page]
        return '\n'.join(result)

    def render_caption(self, text, font_family, font_size, letter_spacing, line_height, max_words_per_line, max_lines_per_page, animation, font_color, stroke_color, stroke_width, width, height, shadow_color, shadow_blur, shadow_offset_x, shadow_offset_y, highlight_color):
        
        text = self._wrap_text(text, max_words_per_line, max_lines_per_page)
        takumi_ast = self._build_takumi_ast(text, font_family, font_size, letter_spacing, line_height, font_color, stroke_color, stroke_width, highlight_color)
        fallback_used = False
        
        # 1. Tentukan path executable murni CLI Takumi
        backend_dir = os.path.join(os.path.dirname(__file__), "backend")
        exe_path = os.path.join(backend_dir, "takumi.exe" if os.name == 'nt' else "takumi")

        # 2. Siapkan file temp untuk menampung JSON masuk dan PNG keluar
        temp_dir = tempfile.gettempdir()
        json_path = os.path.join(temp_dir, "takumi_req.json")
        img_path = os.path.join(temp_dir, "takumi_out.png")

        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(takumi_ast, f)

        if os.path.exists(exe_path):
            try:
                result = subprocess.run(
                    [exe_path, "--input", json_path, "--output", img_path, "--width", str(width), "--height", str(height)],
                    capture_output=True,
                    text=True
                )
                
                if result.returncode == 0 and os.path.exists(img_path):
                    img = Image.open(img_path).convert("RGB")
                    image_tensor = torch.from_numpy(np.array(img).astype(np.float32) / 255.0).unsqueeze(0)
                else:
                    raise Exception(f"Takumi CLI gagal dieksekusi. Error: {result.stderr}")
                    
            except Exception as e:
                raise Exception(f"Fatal Error pada engine Takumi: {e}")
        else:
            raise Exception(f"Binary Takumi tidak ditemukan di: {exe_path}")

        # Bersihkan Temporary Files
        for p in [json_path, img_path]:
            if os.path.exists(p):
                os.remove(p)

        preview_data = {
            "text": text,
            "font_size": font_size,
            "font_color": font_color,
            "stroke_color": stroke_color,
            "stroke_width": stroke_width,
            "highlight_color": highlight_color
        }

        return {"ui": {"preview_data": [preview_data]}, "result": (image_tensor,)}

NODE_CLASS_MAPPINGS = {
    "TakumiCaptionNode": TakumiCaptionNode
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "TakumiCaptionNode": "Takumi Caption (TikTok Style)"
}
