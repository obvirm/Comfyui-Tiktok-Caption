"""
Takumi Caption - ComfyUI Custom Node
Rust/WASM powered caption effects.
"""
import os
import sys

# Add current directory for engine import
current_dir = os.path.dirname(__file__)
if current_dir not in sys.path:
    sys.path.insert(0, current_dir)

from .py.takumi_caption_node import TakumiCaptionNode

NODE_CLASS_MAPPINGS = {
    "TakumiCaptionNode": TakumiCaptionNode
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "TakumiCaptionNode": "Takumi Caption (TikTok Style)"
}

WEB_DIRECTORY = "web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

print("✅ Takumi Caption Loaded!")