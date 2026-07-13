import postcss from 'postcss';
import tailwindcss from 'tailwindcss';
import prefixSelector from 'postcss-prefix-selector';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwindConfig from '../tailwind.config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const IN = 'vendor/tscaps-ui/styles/tokens.css';
const OUT = 'web/css/tscaps-ui.css';

const inPath = path.resolve(root, IN);
const outPath = path.resolve(root, OUT);

const css = fs.readFileSync(inPath, 'utf-8');

// Scope the ENTIRE stylesheet under `.tscaps-ui-root` so it can never leak
// into / reset ComfyUI's own UI. `:root` token block (our dark theme) is
// mapped onto `.tscaps-ui-root`; keyframe selectors are left untouched.
const result = await postcss([
  tailwindcss(tailwindConfig),
  prefixSelector({
    prefix: '.tscaps-ui-root',
    transform(prefix, selector, prefixedSelector) {
      if (selector === ':root') return '.tscaps-ui-root';
      if (/^(from|to|\d+%)$/.test(selector)) return selector;
      return prefixedSelector;
    },
    skip: /^(from|to|\d+%)$/,
  }),
]).process(css, { from: inPath, to: outPath });

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, result.css);
console.log('[build:css] wrote', OUT, result.css.length, 'bytes');
