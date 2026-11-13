import type { ExportOptions } from '../../../preload/personal'
import { useT } from '../../../shared/i18n/react'

/** Export content switches shared by the dashboard modal and the mobile sheet; main re-gates with exportOptions(). */
export default function ExportOptionsFields({
  value,
  onChange,
  images,
  host
}: {
  value: ExportOptions
  onChange: (next: ExportOptions) => void
  /** Screenshots attached to the project's questions. */
  images: number
  /** Linked PC name when the project lives there. */
  host?: string
}): React.JSX.Element {
  const t = useT()
  // Disabled rows show what will actually be exported.
  const rows: { key: keyof ExportOptions; title: string; detail: string; checked: boolean; disabled?: boolean }[] = [
    {
      key: 'conversations',
      title: t('질문·답변 대화'),
      detail: t('끄면 개념과 관계만 담은 그래프로 내보냅니다.'),
      checked: value.conversations
    },
    {
      key: 'memo',
      title: t('내 메모'),
      detail: t('질문에 남긴 메모를 함께 담습니다.'),
      checked: value.conversations && value.memo,
      disabled: !value.conversations
    },
    {
      key: 'images',
      title: t('스크린샷'),
      detail: images > 0 ? t('{{count}}장 · 파일이 커질 수 있습니다.', { count: images }) : t('첨부된 스크린샷이 없습니다.'),
      checked: value.conversations && value.images && images > 0,
      disabled: !value.conversations || images === 0
    },
    {
      key: 'approvedOnly',
      title: t('확인한 관계만'),
      detail: t('내가 확인하지 않은 추천 관계는 뺍니다.'),
      checked: value.approvedOnly
    }
  ]
  return (
    <>
      <fieldset className="export-options">
        <legend>{t('담을 내용')}</legend>
        {rows.map((row) => (
          <label key={row.key} className="check">
            <span className="export-option-text">
              <span>{row.title}</span>
              <small>{row.detail}</small>
            </span>
            <input
              type="checkbox"
              checked={row.checked}
              disabled={row.disabled}
              onChange={(e) => onChange({ ...value, [row.key]: e.target.checked })}
            />
          </label>
        ))}
      </fieldset>
      {host && (
        <p className="export-remote">
          {t(
            '{{name}} PC에서 암호화된 연결로 받아 이 기기에 저장합니다. 그 PC에서 지식 관리자로 승인되어 있어야 합니다.',
            { name: host }
          )}
        </p>
      )}
    </>
  )
}
