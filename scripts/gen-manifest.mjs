import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dir = path.resolve(root, 'web/templates');

if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

const names = fs
  .readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, 'template.json')))
  .map((d) => d.name)
  .sort();

fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(names, null, 2));
console.log('[gen-manifest]', names.length, 'templates ->', path.join(dir, 'manifest.json'));
