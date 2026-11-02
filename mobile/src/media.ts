import { Camera, MediaTypeSelection } from '@capacitor/camera'
import { t } from '@desktop/shared/i18n'

const MAX_EDGE = 2048

/** Long edge capped at 2048px as JPEG 0.9, keeping uploads well under the hub's image limit. */
export async function downscaleToFile(blob: Blob, name: string): Promise<File> {
  const bitmap = await createImageBitmap(blob)
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  bitmap.close()
  const jpeg = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error(t('이미지를 변환할 수 없습니다.')))),
      'image/jpeg',
      0.9
    )
  )
  return new File([jpeg], name, { type: 'image/jpeg' })
}

async function fromWebPath(webPath: string | undefined, name: string): Promise<File[]> {
  if (!webPath) return []
  return [await downscaleToFile(await (await fetch(webPath)).blob(), name)]
}
/** User cancellation is not an error: it yields no files. */
async function cancellable(pick: () => Promise<File[]>): Promise<File[]> {
  try {
    return await pick()
  } catch (e) {
    if (e instanceof Error && /cancel/i.test(e.message)) return []
    throw e
  }
}
export const takePhoto = (): Promise<File[]> =>
  cancellable(async () => {
    const photo = await Camera.takePhoto({ quality: 90, correctOrientation: true })
    return fromWebPath(photo.webPath, 'camera.jpg')
  })
export const choosePhoto = (): Promise<File[]> =>
  cancellable(async () => {
    const { results } = await Camera.chooseFromGallery({
      mediaType: MediaTypeSelection.Photo,
      allowMultipleSelection: false
    })
    return fromWebPath(results[0]?.webPath, 'photo.jpg')
  })
/** Labels are translated at call time so they follow the current UI language. */
export const mediaActions = (): { label: string; pick: () => Promise<File[]> }[] => [
  { label: t('📷 촬영'), pick: takePhoto },
  { label: t('🖼 사진'), pick: choosePhoto }
]
