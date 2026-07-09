import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  define: {
    'process.env.SATORI_STANDALONE': '"0"',
    'process.env.NODE_ENV': '"production"',
    'process.env.JEST_WORKER_ID': 'undefined',
  },
  build: {
    lib: {
      entry: resolve(__dirname, 'src/main.ts'),
      formats: ['iife'],
      name: 'TakumiCaption',
      fileName: 'takumi_caption',
    },
    outDir: 'web/js',
    emptyOutDir: false,
    rollupOptions: {
      external: ['/scripts/app.js'],
      output: {
        globals: {
          '/scripts/app.js': 'app'
        }
      }
    },
    target: 'es2020',
    minify: false,
    sourcemap: false,
  },
  resolve: {
    alias: {
      'satori': resolve(__dirname, 'satori/src/index.ts'),
    }
  }
})
