import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    build: {
      // The WebP encoder (ESM-only, wasm) runs in its own worker thread; bundling it keeps the CJS main output loadable.
      externalizeDeps: { exclude: ['@jsquash/webp'] },
      rollupOptions: {
        input: {
          index: resolve('src/main/index.ts'),
          'webp-worker': resolve('src/main/webp-worker.ts')
        }
      }
    }
  },
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
