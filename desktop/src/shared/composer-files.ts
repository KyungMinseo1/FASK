// Unsent composer file helpers shared by main, renderer, and mobile. No Node or DOM APIs.
import type { ComposerFiles } from '../preload/personal'

/** No image and no documents count as no saved files. */
export const noFiles = (files: ComposerFiles | null | undefined): boolean =>
  !files || (!files.image && !files.documents.length)

/** Same image bytes and the same documents (name and text, in order); none equals empty. */
export function sameFiles(a: ComposerFiles | null, b: ComposerFiles | null): boolean {
  if (!a || !b || noFiles(a) || noFiles(b)) return noFiles(a) && noFiles(b)
  return (
    a.image === b.image &&
    a.documents.length === b.documents.length &&
    a.documents.every((d, i) => d.name === b.documents[i].name && d.text === b.documents[i].text)
  )
}
