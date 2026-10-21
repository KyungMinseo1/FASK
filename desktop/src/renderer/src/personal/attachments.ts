import type { TextAttachment } from '../../../preload/personal'

export const attachmentAccept =
  'image/png,image/jpeg,image/webp,image/gif,.txt,.md,.json,.csv,.tsv,.js,.ts,.tsx,.jsx,.py,.c,.cpp,.h,.html,.css,.yaml,.yml,.log,.sql,.rs,.go,.java,.sh,.toml,.xml'
export async function readAttachment(
  file: File
): Promise<{ image?: string; document?: TextAttachment }> {
  if (file.size > 15 * 1024 * 1024)
    throw new Error(`${file.name}: 첨부는 파일당 15MB까지 지원합니다.`)
  if (/^image\/(png|jpeg|webp|gif)$/.test(file.type)) {
    const bitmap = await createImageBitmap(file)
    try {
      if (bitmap.width * bitmap.height > 25_000_000)
        throw new Error('이미지 해상도가 너무 큽니다. 영역을 잘라 첨부해 주세요.')
      const canvas = document.createElement('canvas')
      canvas.width = bitmap.width
      canvas.height = bitmap.height
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('이미지를 읽을 수 없습니다.')
      ctx.drawImage(bitmap, 0, 0)
      return { image: canvas.toDataURL('image/png') }
    } finally {
      bitmap.close()
    }
  }
  if (
    !/\.(txt|md|json|csv|tsv|js|ts|tsx|jsx|py|c|cpp|h|html|css|yaml|yml|log|sql|rs|go|java|sh|toml|xml)$/i.test(
      file.name
    )
  )
    throw new Error(
      `${file.name}: 이미지 또는 TXT·Markdown·코드 파일을 첨부해 주세요. PDF 등의 문서는 현재 지원하지 않습니다.`
    )
  const text = new TextDecoder('utf-8', { fatal: true }).decode(await file.arrayBuffer())
  if (text.includes('\0')) throw new Error('텍스트 파일만 첨부할 수 있습니다.')
  if (text.length > 50000) throw new Error(`${file.name}: 텍스트는 파일당 50,000자까지 지원합니다.`)
  return { document: { name: file.name, text } }
}
