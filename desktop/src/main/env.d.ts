interface ImportMetaEnv {
  /** Default mobile relay (`wss://…`) baked into release builds. */
  readonly MAIN_VITE_FASK_RELAY_URL?: string
}

declare module '*.md?raw' {
  const text: string
  export default text
}
