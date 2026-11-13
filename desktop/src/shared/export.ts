import type { ExportOptions } from '../preload/personal'

export const EXPORT_DEFAULTS: ExportOptions = { conversations: true, memo: true, images: false, approvedOnly: false }

/** Wire/IPC input → options; anything but a literal boolean takes the default; no conversations means no memo or images. */
export function exportOptions(raw: unknown): ExportOptions {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const pick = (key: keyof ExportOptions): boolean =>
    typeof o[key] === 'boolean' ? (o[key] as boolean) : EXPORT_DEFAULTS[key]
  const conversations = pick('conversations')
  return {
    conversations,
    memo: conversations && pick('memo'),
    images: conversations && pick('images'),
    approvedOnly: pick('approvedOnly')
  }
}

export const exportFileName = (projectName: string): string => `${projectName.replace(/[<>:"/\\|?*]/g, '_')}-fask.zip`
