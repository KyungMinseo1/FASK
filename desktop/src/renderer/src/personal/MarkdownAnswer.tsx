import { useRef } from 'react'
import CopyButton from './CopyButton'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import 'katex/dist/katex.min.css'

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

function CodeBlock({ children }: { children?: React.ReactNode }): React.JSX.Element {
  const ref = useRef<HTMLPreElement>(null)
  return (
    <div className="markdown-code">
      <CopyButton text={() => ref.current?.textContent ?? ''} label="코드 복사" />
      <pre ref={ref}>{children}</pre>
    </div>
  )
}

/** Render model output as text/Markdown, never executable HTML or remote image requests. */
export default function MarkdownAnswer({
  children,
  preview = false
}: {
  children: string
  preview?: boolean
}): React.JSX.Element {
  return (
    <div className={preview ? 'markdown-answer markdown-answer-preview' : 'markdown-answer'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { throwOnError: false, strict: 'ignore' }]]}
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
            <span className="markdown-image-label">[이미지: {alt || '외부 이미지'}]</span>
          ),
          table: ({ children }) => (
            <div className="markdown-table">
              <table>{children}</table>
            </div>
          ),
          ...(preview
            ? {
                input: ({ checked }: { checked?: boolean }) => (
                  <span aria-label={checked ? '완료' : '미완료'}>{checked ? '☑' : '☐'}</span>
                )
              }
            : { pre: CodeBlock })
        }}
      >
        {normalizeMath(children)}
      </ReactMarkdown>
    </div>
  )
}
