import { useEffect, useState } from 'react'
import type { ExportOptions } from '@desktop/preload/personal'
import { EXPORT_DEFAULTS, exportFileName } from '@desktop/shared/export'
import { questionImages } from '@desktop/shared/questions'
import { errorText } from '@desktop/renderer/src/personal/common'
import ExportOptionsFields from '@desktop/renderer/src/personal/ExportOptionsFields'
import { useT } from '@desktop/shared/i18n/react'
import { useMobile } from '../context'
import { saveDocument } from '../transport'

/** The hub (or the linked PC behind it) builds the zip; the phone saves it where the user picks. */
export default function ExportSheet({ projectId, onClose }: { projectId: string; onClose: () => void }): React.JSX.Element {
  const { data, client } = useMobile()
  const t = useT()
  const [options, setOptions] = useState<ExportOptions>(EXPORT_DEFAULTS)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const project = data.projects.find((p) => p.id === projectId)
  const host = data.workspaces.find((w) => w.id === project?.workspaceId)?.remote?.name
  const images = new Set(data.questions.filter((q) => q.projectId === projectId).flatMap(questionImages)).size
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])
  const save = async (): Promise<void> => {
    if (!project) return
    setBusy(true)
    setError('')
    try {
      const archive = await client.exportArchive(projectId, options)
      // A cancelled picker keeps the sheet open without an error.
      if (await saveDocument(exportFileName(project.name), 'application/zip', archive)) onClose()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mobile-sheet-backdrop" onClick={() => !busy && onClose()}>
      <div
        className="mobile-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t('기억 내보내기')}
        onClick={(e) => e.stopPropagation()}
      >
        <strong>{t('기억 내보내기')}</strong>
        <ExportOptionsFields value={options} onChange={setOptions} images={images} host={host} />
        {error && <p className="notice error">{error}</p>}
        <button className="primary" disabled={busy || !project} onClick={() => void save()}>
          {busy ? t('준비 중…') : t('내보내기')}
        </button>
        <button disabled={busy} onClick={onClose}>
          {t('취소')}
        </button>
      </div>
    </div>
  )
}
