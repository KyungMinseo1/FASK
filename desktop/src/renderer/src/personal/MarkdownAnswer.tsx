import { memo, useRef } from 'react'
import CopyButton from './CopyButton'
import { Icon } from './ToolbarIcons'
import ReactMarkdown, { type Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'
import 'katex/contrib/copy-tex'
import { useT } from '../../../shared/i18n/react'
import { previewSource } from './preview-source'

/** Models often emit \(..\) / \[..\]; remark-math only knows $..$ / $$..$$. Skip code spans/blocks. */
function normalizeMath(text: string): string {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/\\\[([\s\S]+?)\\\]/g, (_, m) => `\n$$\n${m.trim()}\n$$\n`)
            .replace(/\\\(([\s\S]+?)\\\)/g, (_, m) => `$${m.trim()}$`)
    )
    .join('')
}

type HastNode = {
  type: string
  tagName?: string
  properties?: { className?: unknown }
  children?: HastNode[]
}

/** rehype-katex turns `$$` blocks into `span.katex-display`; wrap each in a figure so it gets a copy button. */
function rehypeMathBlock(): (tree: HastNode) => void {
  const wrap = (node: HastNode): void => {
    node.children?.forEach((child, i, siblings) => {
      const className = child.properties?.className
      if (
        child.type === 'element' &&
        child.tagName === 'span' &&
        Array.isArray(className) &&
        className.includes('katex-display')
      ) {
        siblings[i] = {
          type: 'element',
          tagName: 'figure',
          properties: { className: ['markdown-math'] },
          children: [child]
        }
      } else wrap(child)
    })
  }
  return wrap
}

const KATEX: NonNullable<Options['rehypePlugins']>[number] = [
  rehypeKatex,
  { throwOnError: false, strict: 'ignore' }
]
const PREVIEW_REHYPE: Options['rehypePlugins'] = [KATEX]
const FULL_REHYPE: Options['rehypePlugins'] = [KATEX, rehypeMathBlock]

function CodeBlock({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const t = useT()
  const ref = useRef<HTMLPreElement>(null)
  return (
    <div className="markdown-code">
      <CopyButton text={() => ref.current?.textContent ?? ''} label={t('코드 복사')} />
      <pre ref={ref}>{children}</pre>
    </div>
  )
}

function MathBlock({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const t = useT()
  const ref = useRef<HTMLElement>(null)
  return (
    <figure className="markdown-math" ref={ref}>
      <CopyButton
        text={() =>
          ref.current
            ?.querySelector('annotation[encoding="application/x-tex"]')
            ?.textContent?.trim() ?? ''
        }
        label={t('LaTeX 복사')}
      />
      {children}
    </figure>
  )
}

/** Render model output as text/Markdown, never executable HTML or remote image requests. */
function MarkdownAnswer({
  children,
  preview = false
}: {
  children: string
  preview?: boolean
}): React.JSX.Element {
  const t = useT()
  return (
    <div className={preview ? 'markdown-answer markdown-answer-preview' : 'markdown-answer'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={preview ? PREVIEW_REHYPE : FULL_REHYPE}
        skipHtml
        components={{
          a: ({ href, children }) =>
            preview ? (
              <span>{children}</span>
            ) : (
              <a href={href} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ),
          img: ({ alt }) => (
            <span className="markdown-image-label">
              {t('[이미지: {{alt}}]', { alt: alt || t('외부 이미지') })}
            </span>
          ),
          table: ({ children }) => (
            <div className="markdown-table">
              <table>{children}</table>
            </div>
          ),
          ...(preview
            ? {
                input: ({ checked }: { checked?: boolean }) => (
                  <span className="markdown-task" aria-label={checked ? t('완료') : t('미완료')}>
                    <Icon name={checked ? 'boxChecked' : 'box'} size={14} />
                  </span>
                )
              }
            : { pre: CodeBlock, figure: MathBlock })
        }}
      >
        {normalizeMath(preview ? previewSource(children) : children)}
      </ReactMarkdown>
    </div>
  )
}

export default memo(MarkdownAnswer)
