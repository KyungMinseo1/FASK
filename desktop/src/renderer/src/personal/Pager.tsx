import { pageWindow } from '../../../shared/questions'
import { useT } from '../../../shared/i18n/react'

export default function Pager({
  page,
  pages,
  onPage
}: {
  page: number
  pages: number
  onPage: (page: number) => void
}): React.JSX.Element | null {
  const t = useT()
  if (pages <= 1) return null
  return (
    <nav className="pager" aria-label={t('페이지')}>
      <button aria-label={t('이전 페이지')} disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ‹
      </button>
      {pageWindow(page, pages).map((p, i) =>
        p === 'gap' ? (
          <span key={`gap-${i}`}>…</span>
        ) : (
          <button
            key={p}
            className={p === page ? 'active' : undefined}
            aria-current={p === page ? 'page' : undefined}
            onClick={() => onPage(p)}
          >
            {p}
          </button>
        )
      )}
      <button aria-label={t('다음 페이지')} disabled={page >= pages} onClick={() => onPage(page + 1)}>
        ›
      </button>
    </nav>
  )
}
