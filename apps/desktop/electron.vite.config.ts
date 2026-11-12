import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { injectCsp } from './src/main/csp'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  main: {
    build: {
      outDir: resolve(root, 'dist/main'),
      externalizeDeps: false,
      rolldownOptions: {
        input: resolve(root, 'src/main/index.ts'),
        output: { format: 'es', entryFileNames: 'index.mjs' },
      },
    },
  },
  preload: {
    build: {
      outDir: resolve(root, 'dist/preload'),
      externalizeDeps: false,
      rolldownOptions: {
        input: resolve(root, 'src/preload/index.ts'),
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root: resolve(root, 'src/renderer-shell'),
    plugins: [react(), { name: 'rill-csp', apply: 'build', transformIndexHtml: { order: 'post', handler: injectCsp } }],
    build: {
      outDir: resolve(root, 'dist/renderer'),
      emptyOutDir: true,
      rolldownOptions: { input: resolve(root, 'src/renderer-shell/index.html') },
    },
  },
})
