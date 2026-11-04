// Bundles the main-process modules the Electron test harnesses load from tests/.smoke.
const { buildSync } = require('esbuild')
const { mkdirSync } = require('node:fs')
const { join } = require('node:path')
const dir = join(__dirname, '.smoke')
mkdirSync(dir, { recursive: true })
buildSync({
  entryPoints: [join(__dirname, '../src/main/personal.ts')],
  outfile: join(dir, 'personal.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // Bundled, opaque-ts's sjcl dependency assigns module.exports and would replace this bundle's exports.
  // @jsquash/webp is only require.resolve'd for its wasm path.
  external: ['electron', '@cloudflare/opaque-ts', '@jsquash/webp'],
  // personal.ts reads build-time vars from import.meta.env, which a plain CJS bundle lacks.
  define: { __dirname: JSON.stringify(join(__dirname, '../out/main')), 'import.meta.env': '{}' }
})
buildSync({
  entryPoints: [join(__dirname, '../src/main/personal-store.ts')],
  outfile: join(dir, 'store.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs'
})
buildSync({
  entryPoints: [join(__dirname, '../src/main/personal-hub.ts')],
  outfile: join(dir, 'hub.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs'
})
buildSync({
  entryPoints: [join(__dirname, '../src/main/webp-worker.ts')],
  outfile: join(dir, 'webp-worker.js'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // The emscripten glue builds its wasm URL from import.meta.url at load time; the worker passes a precompiled module.
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': '__importMetaUrl' }
})
