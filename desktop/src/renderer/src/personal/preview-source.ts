const PREVIEW_CHARS = 600

/** Cheap prefix for list cards: cut near 600 chars without leaving a code fence or $$ block open. */
export function previewSource(text: string): string {
  if (text.length <= PREVIEW_CHARS) return text
  const nl = text.indexOf('\n', PREVIEW_CHARS)
  let out = text.slice(0, nl === -1 ? PREVIEW_CHARS : nl)
  for (;;) {
    const fences = [...out.matchAll(/^```/gm)].map((m) => m.index)
    if (fences.length % 2) {
      out = out.slice(0, fences[fences.length - 1])
      continue
    }
    const maths = [...out.matchAll(/\$\$/g)].map((m) => m.index)
    if (maths.length % 2) {
      out = out.slice(0, maths[maths.length - 1])
      continue
    }
    return out.trimEnd()
  }
}
