import type { CapacitorConfig } from '@capacitor/cli'

// Hub traffic goes through the native FaskHub plugin, so no cleartext or mixed content is needed.
const config: CapacitorConfig = {
  appId: 'io.github.kyungminseo1.fask',
  appName: 'FASK',
  webDir: 'dist'
}

export default config
