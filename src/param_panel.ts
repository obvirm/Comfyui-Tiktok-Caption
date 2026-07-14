// Dynamic per-template Parameters panel.
//
// tscaps ships every control a template needs INSIDE the template itself
// (template.json): `typography`, `alignment`, `effects`, and `styleControls`.
// Those controls are "terdinamis" — they differ per template. This module
// renders them as real UI widgets into the existing right-sidebar panel
// (the one that already holds the template 📚 gallery), under a second tab
// "Parameters". Changing a control updates the ACTIVE TikTokCaption node's
// `template_overrides` widget (a single JSON string) which the node merges
// on top of the template defaults at render time — exactly like tscaps merges
// a sheet's style values over the template's own defaults.
//
// Scope: per active tab (app.rootGraph), matching how the gallery applies.

import { FONT_CATALOG } from './font_catalog';

interface ControlField {
  id: string;
  label: string;
  type: string;
  default: any;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  advanced?: boolean;
  group?: string;
  options?: { value: string; label: string; cssValue?: string }[];
  valueOn?: string;
  valueOff?: string;
}

// Map a template.json typography field → a ControlField so it reuses the same
// renderer as styleControls.
function typoToControl(id: string, label: string, val: any): ControlField {
  if (typeof val === 'boolean') {
    return { id, label, type: 'toggle', default: val, valueOn: '1', valueOff: '0' };
  }
  if (id === 'fontFamily') {
    return { id, label, type: 'select', default: val, options: FONT_CATALOG.map((f) => ({ value: f, label: f.replace(/ Variable$/, '') })) };
  }
  if (id === 'fontWeight') {
    return { id, label, type: 'integer', default: val, min: 100, max: 900, step: 100 };
  }
  if (id === 'textAlign') {
    return { id, label, type: 'select', default: val, options: ['left', 'center', 'right'].map((v) => ({ value: v, label: v })) };
  }
  if (id === 'textCase') {
    return { id, label, type: 'select', default: val, options: ['none', 'uppercase', 'lowercase'].map((v) => ({ value: v, label: v })) };
  }
  if (id === 'fontSize') return { id, label, type: 'float', default: val, min: 0.5, max: 30, step: 0.1, unit: 'cqh' };
  if (id === 'letterSpacing' || id === 'wordSpacing' || id === 'lineSpacing')
    return { id, label, type: 'float', default: val, min: -0.5, max: 1, step: 0.005, unit: 'em' };
  return { id, label, type: 'text', default: val };
}

export interface TemplateControls {
  typography: ControlField[];
  alignment: ControlField[];
  effects: ControlField[];
  styleControls: ControlField[];
}

export function controlsFromTemplate(data: any): TemplateControls {
  const t = data?.typography || {};
  const typography: ControlField[] = [
    typoToControl('fontFamily', 'Font', t.fontFamily ?? 'Inter Variable'),
    typoToControl('fontSize', 'Size', t.fontSize ?? 4),
    typoToControl('fontWeight', 'Weight', t.fontWeight ?? 400),
    typoToControl('letterSpacing', 'Letter spacing', t.letterSpacing ?? 0),
    typoToControl('wordSpacing', 'Word spacing', t.wordSpacing ?? 0),
    typoToControl('lineSpacing', 'Line spacing', t.lineSpacing ?? 0),
    typoToControl('textAlign', 'Align', t.textAlign ?? 'center'),
    typoToControl('textCase', 'Case', t.textCase ?? 'none'),
    typoToControl('italic', 'Italic', !!t.italic),
    typoToControl('underline', 'Underline', !!t.underline),
    typoToControl('strikethrough', 'Strikethrough', !!t.strikethrough),
  ];
  const a = data?.alignment || {};
  const alignment: ControlField[] = [
    { id: 'verticalAlign', label: 'Vertical', type: 'select', default: a.verticalAlign ?? 'center', options: ['top', 'center', 'bottom'].map((v) => ({ value: v, label: v })) },
    { id: 'verticalOffset', label: 'V offset', type: 'float', default: a.verticalOffset ?? 0.5, min: 0, max: 1, step: 0.01 },
    { id: 'horizontalAlign', label: 'Horizontal', type: 'select', default: a.horizontalAlign ?? 'center', options: ['left', 'center', 'right'].map((v) => ({ value: v, label: v })) },
    { id: 'horizontalOffset', label: 'H offset', type: 'float', default: a.horizontalOffset ?? 0.5, min: 0, max: 1, step: 0.01 },
  ];
  // Effects → toggles (gap_free, remove_punctuation, smart_punctuation,
  // smart_lowercase, carry_quotes, emoji). emoji maps to its own config below.
  const effects: ControlField[] = (data?.effects || [])
    .filter((e: any) => e?.type && e.type !== 'emoji')
    .map((e: any) => ({ id: 'effect:' + e.type, label: e.type.replace(/_/g, ' '), type: 'toggle', default: !!e.enabled, valueOn: '1', valueOff: '0' }));
  const styleControls: ControlField[] = (data?.styleControls || []).map((c: any) => ({
    id: c.id, label: c.label, type: c.type, default: c.default,
    min: c.min, max: c.max, step: c.step, unit: c.unit, advanced: c.advanced,
    group: c.group, options: c.options, valueOn: c.valueOn, valueOff: c.valueOff,
  }));
  return { typography, alignment, effects, styleControls };
}

// Resolve the current override map from the active node.
function getOverrides(node: any): Record<string, any> {
  const w = node?.widgets?.find((x: any) => x.name === 'template_overrides');
  if (!w || !w.value) return {};
  try { return JSON.parse(w.value); } catch { return {}; }
}
function setOverrides(node: any, map: Record<string, any>): void {
  const w = node?.widgets?.find((x: any) => x.name === 'template_overrides');
  if (!w) return;
  w.value = JSON.stringify(map);
  // Notify ComfyUI of the change (persist + trigger graph dirty).
  if (typeof (node as any).setSize?._?.(node) === 'function') { /* noop */ }
  (window as any).app?.graph?.setDirty?.(true);
}

function activeNode(): any | null {
  const app = (window as any).app;
  const nodes: any[] = app?.rootGraph?.nodes ?? [];
  return nodes.find((n: any) => n?.type === 'TikTokCaptionNode') || null;
}

function groupLabel(g: string): string {
  if (g === 'colors') return 'Colors';
  if (g === 'appearance') return 'Appearance';
  if (g === 'assets') return 'Assets';
  return g;
}

// Render one ControlField into a row. Returns {el, read}.
function renderControl(field: ControlField, value: any, onChange: (v: any) => void) {
  const row = document.createElement('div');
  row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin:4px 0;';
  const lbl = document.createElement('label');
  lbl.textContent = field.label;
  lbl.style.cssText = 'font-size:11px;color:rgb(200 200 210);flex:0 0 38%;';
  const ctrl = document.createElement('div');
  ctrl.style.cssText = 'flex:1;display:flex;justify-content:flex-end;';
  let read: () => any;

  if (field.type === 'color') {
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = typeof value === 'string' && value.startsWith('#') ? value : (field.default || '#ffffff');
    inp.style.cssText = 'width:42px;height:24px;border:none;background:none;cursor:pointer;';
    inp.oninput = () => onChange(inp.value);
    ctrl.appendChild(inp);
    read = () => inp.value;
  } else if (field.type === 'toggle') {
    const sel = document.createElement('select');
    sel.style.cssText = 'font-size:11px;';
    const on = field.valueOn ?? '1';
    const off = field.valueOff ?? '0';
    sel.innerHTML = `<option value="on">on</option><option value="off">off</option>`;
    sel.value = value ? 'on' : 'off';
    sel.onchange = () => onChange(sel.value === 'on');
    ctrl.appendChild(sel);
    read = () => sel.value === 'on';
  } else if (field.type === 'select') {
    const sel = document.createElement('select');
    sel.style.cssText = 'font-size:11px;max-width:140px;';
    for (const o of field.options || []) {
      const opt = document.createElement('option');
      opt.value = o.value; opt.textContent = o.label;
      sel.appendChild(opt);
    }
    sel.value = value ?? field.default;
    sel.onchange = () => onChange(sel.value);
    ctrl.appendChild(sel);
    read = () => sel.value;
  } else if (field.type === 'font') {
    const sel = document.createElement('select');
    sel.style.cssText = 'font-size:11px;max-width:140px;';
    for (const f of FONT_CATALOG) {
      const opt = document.createElement('option');
      opt.value = f; opt.textContent = f.replace(/ Variable$/, '');
      sel.appendChild(opt);
    }
    sel.value = value ?? field.default;
    sel.onchange = () => onChange(sel.value);
    ctrl.appendChild(sel);
    read = () => sel.value;
  } else if (field.type === 'integer' || field.type === 'float') {
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.step = String(field.step ?? (field.type === 'integer' ? 1 : 0.01));
    if (field.min !== undefined) inp.min = String(field.min);
    if (field.max !== undefined) inp.max = String(field.max);
    inp.value = String(value ?? field.default ?? 0);
    inp.style.cssText = 'width:90px;font-size:11px;';
    const unit = field.unit || '';
    inp.oninput = () => onChange(parseFloat(inp.value) || 0);
    ctrl.appendChild(inp);
    if (unit) {
      const u = document.createElement('span');
      u.textContent = unit;
      u.style.cssText = 'font-size:10px;color:#888;margin-left:3px;';
      ctrl.appendChild(u);
    }
    read = () => parseFloat(inp.value) || 0;
  } else if (field.type === 'image') {
    const span = document.createElement('span');
    span.textContent = '(image)';
    span.style.cssText = 'font-size:10px;color:#888;';
    ctrl.appendChild(span);
    read = () => value;
  } else { // text
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = String(value ?? field.default ?? '');
    inp.style.cssText = 'width:110px;font-size:11px;';
    inp.oninput = () => onChange(inp.value);
    ctrl.appendChild(inp);
    read = () => inp.value;
  }

  row.appendChild(lbl);
  row.appendChild(ctrl);
  return { el: row, read };
}

// Render the parameters tab into `host`. Re-renders whenever the active
// template changes (call refresh() after selecting a gallery template).
export function renderParametersTab(host: HTMLElement): { refresh: () => void } {
  function refresh() {
    host.innerHTML = '';
    const node = activeNode();
    const tpl = node?.widgets?.find((x: any) => x.name === 'template')?.value;
    if (!tpl || tpl === '(none / custom)') {
      host.innerHTML = '<div style="color:#888;font-size:11px;padding:8px">Pilih template dulu untuk edit parameternya.</div>';
      return;
    }
    const ov = getOverrides(node);
    // Fetch template.json to get the control definitions.
    fetch(`/extensions/Comfyui-Caption-Live/templates/${encodeURIComponent(tpl)}/template.json`)
      .then((r) => r.json())
      .then((data) => {
        const ctrls = controlsFromTemplate(data);
        const sections: [string, ControlField[]][] = [
          ['Typography', ctrls.typography],
          ['Position', ctrls.alignment],
          ['Effects', ctrls.effects],
          ['Style', ctrls.styleControls],
        ];
        for (const [title, fields] of sections) {
          if (!fields.length) continue;
          const h = document.createElement('div');
          h.textContent = title;
          h.style.cssText = 'font-size:11px;font-weight:600;color:rgb(160 160 200);margin:10px 0 4px;text-transform:uppercase;letter-spacing:.04em;';
          host.appendChild(h);
          for (const f of fields) {
            const cur = ov[f.id] ?? f.default;
            const { el } = renderControl(f, cur, (v) => {
              const m = getOverrides(node);
              m[f.id] = v;
              setOverrides(node, m);
              // trigger node re-render via the same hook the gallery uses
              if (typeof node?.tscapsApply === 'function') node.tscapsApply(node.widgets.find((x: any) => x.name === 'template')?.value);
            });
            host.appendChild(el);
          }
        }
      })
      .catch((e) => {
        host.innerHTML = `<div style="color:rgb(248 113 113);font-size:11px;padding:8px">Gagal memuat kontrol: ${e}</div>`;
      });
  }
  refresh();
  return { refresh };
}
