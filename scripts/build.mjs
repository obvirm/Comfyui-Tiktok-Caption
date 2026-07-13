import { build, context } from 'esbuild';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const watch = process.argv.includes('--watch');

const aliases = {
  '@modules': './vendor/tscaps-engine/modules',
  '@tscaps/engine': './vendor/tscaps-engine/index.ts',
  '@ui': './vendor/tscaps-ui/ui',
  '@core': './vendor/tscaps-ui/core',
  '@presentation': './vendor/tscaps-ui/presentation',
  '@styles': './vendor/tscaps-ui/styles',
};

const entries = [
  { in: 'src/tiktok_caption.ts', out: 'web/js/tiktok_caption.js', external: [] },
];

for (const e of entries) {
  const opts = {
    entryPoints: [path.resolve(root, e.in)],
    bundle: true,
    minify: true,
    sourcemap: false,
    outfile: path.resolve(root, e.out),
    alias: aliases,
    external: e.external,
    jsx: 'automatic',
    jsxImportSource: 'react',
    logLevel: 'info',
  };
  if (watch) {
    const ctx = await context(opts);
    await ctx.watch();
    console.log('[build] watching', e.out);
  } else {
    await build(opts);
    console.log('[build] built', e.out);
  }
}
