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


# Module-level map: control id → --tscaps-* css var name (shared by
# _controls_to_vars and apply_overrides so overrides and defaults agree).
_CONTROL_VAR_MAP = {
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
    v = {}
    for c in controls or []:
        cid = c.get("id")
        if cid in _CONTROL_VAR_MAP and "default" in c:
            val = c["default"]
            if cid == "font-family":
                # Quote multi-word family names.
                val = f"'{val}'"
            if cid in ("font-size", "letter-spacing", "word-spacing", "line-spacing"):
                val = f"{val}em" if cid != "font-size" else f"{val}cqh"
            if cid == "rotation":
                val = f"{val}deg"
            v[_CONTROL_VAR_MAP[cid]] = str(val)
    return v


# Expose so apply_overrides resolves the same var name as the defaults.
_STYLECONTROL_VAR_MAP = _CONTROL_VAR_MAP


# Expose the styleControls id_map so apply_overrides can resolve the same
# --tscaps-* var name a template's own defaults use (e.g. primary-color →
# --tscaps-primary-color), keeping overrides consistent with the defaults.
_STYLECONTROL_VAR_MAP = _CONTROL_VAR_MAP


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


# ── Per-template dynamic overrides (sidebar Parameters panel) ──────────────
# Maps a control-id → value map (written by the browser panel) onto the same
# --tscaps-* CSS variables load_template produces, so changing a control in
# the UI updates the render exactly like tscaps merges a sheet over a template.
_TYPO_VAR_MAP = {
    "fontFamily": "--tscaps-font-family",
    "fontSize": "--tscaps-font-size",
    "fontWeight": "--tscaps-font-weight",
    "letterSpacing": "--tscaps-letter-spacing",
    "wordSpacing": "--tscaps-word-spacing",
    "lineSpacing": "--tscaps-line-spacing",
    "textAlign": "--tscaps-text-align",
    "textCase": "--tscaps-text-transform",
    "fontStyle": "--tscaps-font-style",
    "textDecoration": "--tscaps-text-decoration",
}


def apply_overrides(overrides: dict, css: str = "") -> dict:
    """Return a --tscaps-* var map for the given control override map."""
    out: dict = {}
    for cid, val in (overrides or {}).items():
        # styleControls ids → --tscaps-<id> (using the same id_map the
        # template defaults use, so e.g. primary-color → --tscaps-primary-color).
        if not cid.startswith("effect:") and cid not in (
            "verticalAlign", "verticalOffset", "horizontalAlign", "horizontalOffset"
        ):
            var = _TYPO_VAR_MAP.get(cid) or _STYLECONTROL_VAR_MAP.get(cid) or f"--tscaps-{cid}"
            out[var] = _coerce_override(cid, val)
        # alignment keys are consumed by the node separately (not CSS vars)
    return out


def _coerce_override(cid: str, val) -> str:
    """Render an override value into the CSS string a --tscaps-* var expects."""
    if cid == "fontFamily":
        return f"'{val}'"
    if cid in ("fontSize",) and not str(val).endswith("cqh"):
        return f"{val}cqh"
    if cid in ("letterSpacing", "wordSpacing", "lineSpacing") and isinstance(val, (int, float)):
        return f"{val}em"
    if cid in ("verticalOffset", "horizontalOffset") and isinstance(val, (int, float)):
        return str(val)
    if isinstance(val, bool):
        return "1" if val else "0"
    return str(val)

