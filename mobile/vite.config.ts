import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const here = (file: string): string => fileURLToPath(new URL(file, import.meta.url))
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Shared desktop sources belong to this app's compilation. A JSON string is
  // intentional: Vite still discovers per-file desktop tsconfigs for object values.
  esbuild: { tsconfigRaw: readFileSync(new URL('./tsconfig.json', import.meta.url), 'utf8') },
  resolve: {
    alias: { '@desktop': fileURLToPath(new URL('../desktop/src', import.meta.url)) },
    // Bare imports inside desktop sources resolve from mobile/node_modules: one React copy.
    dedupe: [
      'react',
      'react-dom',
      'react-router',
      'react-markdown',
      'remark-gfm',
      'remark-math',
      'rehype-katex',
      'katex',
      '@xyflow/react',
      'd3-hierarchy'
    ]
  },
  server: { host: '127.0.0.1', port: 5173, fs: { allow: ['..'] } },
  // Relative URLs: the app loads from the Capacitor root, the panel from /assets/public/.
  base: './',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: { main: here('index.html'), overlay: here('overlay.html') }
    }
  },
  test: { environment: 'node', include: ['tests/**/*.test.{ts,tsx}'] }
})
