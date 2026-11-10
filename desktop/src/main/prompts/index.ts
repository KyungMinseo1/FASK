// LLM instructions are Markdown templates under prompts/<language>/; `{{name}}` is filled at call time.
// Both languages define the same placeholders (tests/prompts.test.ts).
import type { LocalSettings } from '../../preload/personal'
import koAnswer from './ko/answer.md?raw'
import koAnswerMemory from './ko/answer-memory.md?raw'
import koAnnotation from './ko/annotation.md?raw'
import koTitle from './ko/title.md?raw'
import koTitleQuestion from './ko/title-question.md?raw'
import koTitleAttachments from './ko/title-attachments.md?raw'
import koTitleFile from './ko/title-file.md?raw'
import koRefine from './ko/refine.md?raw'
import koSearchKeywords from './ko/search-keywords.md?raw'
import koSearchKeywordsFallback from './ko/search-keywords-fallback.md?raw'
import koAttachments from './ko/attachments.md?raw'
import koExtract from './ko/extract.md?raw'
import koTidy from './ko/tidy.md?raw'
import koRetag from './ko/retag.md?raw'
import enAnswer from './en/answer.md?raw'
import enAnswerMemory from './en/answer-memory.md?raw'
import enAnnotation from './en/annotation.md?raw'
import enTitle from './en/title.md?raw'
import enTitleQuestion from './en/title-question.md?raw'
import enTitleAttachments from './en/title-attachments.md?raw'
import enTitleFile from './en/title-file.md?raw'
import enRefine from './en/refine.md?raw'
import enSearchKeywords from './en/search-keywords.md?raw'
import enSearchKeywordsFallback from './en/search-keywords-fallback.md?raw'
import enAttachments from './en/attachments.md?raw'
import enExtract from './en/extract.md?raw'
import enTidy from './en/tidy.md?raw'
import enRetag from './en/retag.md?raw'

export type PromptLanguage = LocalSettings['promptLanguage']

/** CRLF checkouts on Windows must not change what the model receives. */
const clean = (text: string): string => text.replace(/\r\n/g, '\n').trimEnd()

const ko = {
  answer: clean(koAnswer),
  'answer-memory': clean(koAnswerMemory),
  annotation: clean(koAnnotation),
  title: clean(koTitle),
  'title-question': clean(koTitleQuestion),
  'title-attachments': clean(koTitleAttachments),
  'title-file': clean(koTitleFile),
  refine: clean(koRefine),
  'search-keywords': clean(koSearchKeywords),
  'search-keywords-fallback': clean(koSearchKeywordsFallback),
  attachments: clean(koAttachments),
  extract: clean(koExtract),
  tidy: clean(koTidy),
  retag: clean(koRetag)
}
export type PromptName = keyof typeof ko
const en: Record<PromptName, string> = {
  answer: clean(enAnswer),
  'answer-memory': clean(enAnswerMemory),
  annotation: clean(enAnnotation),
  title: clean(enTitle),
  'title-question': clean(enTitleQuestion),
  'title-attachments': clean(enTitleAttachments),
  'title-file': clean(enTitleFile),
  refine: clean(enRefine),
  'search-keywords': clean(enSearchKeywords),
  'search-keywords-fallback': clean(enSearchKeywordsFallback),
  attachments: clean(enAttachments),
  extract: clean(enExtract),
  tidy: clean(enTidy),
  retag: clean(enRetag)
}
export const PROMPTS: Record<PromptLanguage, Record<PromptName, string>> = { ko, en }

/** The `name` instruction in `language`; each `{{key}}` is replaced once by `vars[key]` (values are not re-scanned). */
export function prompt(language: PromptLanguage, name: PromptName, vars: Record<string, string> = {}): string {
  return PROMPTS[language][name].replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
    const value = vars[key]
    if (value === undefined) throw new Error(`Prompt ${language}/${name} needs {{${key}}}`)
    return value
  })
}
