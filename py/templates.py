"""
Takumi Caption — tscaps template loader.

Reads a tscaps template folder (style.css + template.json) and produces the
CSS plus the default CSS-variable map (inlineStyles) the engine needs, so the
node renders EXACTLY like tscaps' built-in templates out of the box.
"""
import os, json

TEMPLATES_DIR = os.path.join(os.path.dirname(__file__), "..", "web", "templates")


def list_templates() -> list:
    """Return sorted list of available template names (folders with style.css)."""
    if not os.path.isdir(TEMPLATES_DIR):
        return []
    out = []
    for name in os.listdir(TEMPLATES_DIR):
        css_path = os.path.join(TEMPLATES_DIR, name, "style.css")
        if os.path.isfile(css_path):
            out.append(name)
    return sorted(out)


def _typography_to_vars(typ: dict) -> dict:
    """Map template.json typography → --tscaps-* CSS variables."""
    v = {}
    if "fontFamily" in typ:
        # Always quote multi-word families (e.g. 'Komika Axis') so the CSS var
        # resolves to a valid font-family value when used in `var(...)`.
        v["--tscaps-font-family"] = f"'{typ['fontFamily']}'"
    if "fontWeight" in typ:
        v["--tscaps-font-weight"] = str(typ["fontWeight"])
    if typ.get("italic"):
        v["--tscaps-font-style"] = "italic"
    if "fontSize" in typ:
        v["--tscaps-font-size"] = f"{typ['fontSize']}cqh"
    if "letterSpacing" in typ:
        v["--tscaps-letter-spacing"] = f"{typ['letterSpacing']}em"
    if "wordSpacing" in typ:
        v["--tscaps-word-spacing"] = f"{typ['wordSpacing']}em"
    if "lineSpacing" in typ:
        v["--tscaps-line-spacing"] = f"{typ['lineSpacing']}em"
    if "textCase" in typ:
        v["--tscaps-text-transform"] = typ["textCase"]
    if "textAlign" in typ:
        v["--tscaps-text-align"] = typ["textAlign"]
    if "textDecoration" in typ:
        v["--tscaps-text-decoration"] = typ["textDecoration"]
    if "rotation" in typ:
        v["--tscaps-rotation"] = f"{typ['rotation']}deg"
    return v


def _controls_to_vars(controls: list) -> dict:
    """Map template.json styleControls[].default → --tscaps-* CSS variables."""
    # Map control id → css var name
    id_map = {
        "primary-color": "--tscaps-primary-color",
        "highlight-color": "--tscaps-highlight-color",
        "shadow-color": "--tscaps-shadow-color",
        "outline-color": "--tscaps-outline-color",
        "quote-color": "--tscaps-quote-color",
        "chroma-a": "--tscaps-chroma-a",
        "chroma-b": "--tscaps-chroma-b",
        "font-size": "--tscaps-font-size",
        "font-family": "--tscaps-font-family",
        "font-weight": "--tscaps-font-weight",
        "letter-spacing": "--tscaps-letter-spacing",
        "word-spacing": "--tscaps-word-spacing",
        "line-spacing": "--tscaps-line-spacing",
        "rotation": "--tscaps-rotation",
        "text-align": "--tscaps-text-align",
        "text-case": "--tscaps-text-transform",
    }
    v = {}
    for c in controls or []:
        cid = c.get("id")
        if cid in id_map and "default" in c:
            val = c["default"]
            if cid == "font-family":
                # Quote multi-word family names.
                val = f"'{val}'"
            if cid in ("font-size", "letter-spacing", "word-spacing", "line-spacing"):
                val = f"{val}em" if cid != "font-size" else f"{val}cqh"
            if cid == "rotation":
                val = f"{val}deg"
            v[id_map[cid]] = str(val)
    return v


def load_template(name: str, font_scale: float = 1.0) -> dict:
    """Return {css, inlineStyles} for a template, or None if missing.
    font_scale multiplies --tscaps-font-size so tscaps' 16:9-oriented
    templates read well inside a vertical 9:16 caption frame."""
    folder = os.path.join(TEMPLATES_DIR, name)
    css_path = os.path.join(folder, "style.css")
    json_path = os.path.join(folder, "template.json")
    if not os.path.isfile(css_path):
        return None
    with open(css_path, "r", encoding="utf-8") as f:
        css = f.read()
    inline = {}
    if os.path.isfile(json_path):
        try:
            data = json.load(open(json_path, "r", encoding="utf-8"))
            inline.update(_typography_to_vars(data.get("typography", {})))
            inline.update(_controls_to_vars(data.get("styleControls", [])))
        except Exception:
            pass
    # Scale font-size for vertical caption frames
    for k, v in list(inline.items()):
        if k == "--tscaps-font-size":
            try:
                num = float(str(v).replace("cqh", ""))
                inline[k] = f"{num * font_scale:.2f}cqh"
            except ValueError:
                pass
    return {"css": css, "inlineStyles": inline}
