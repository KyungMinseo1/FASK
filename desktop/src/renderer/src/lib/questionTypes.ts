import type { QuestionType } from '../api/types'
import { t } from '../../../shared/i18n'

export const QUESTION_TYPE_LABEL: Record<QuestionType, string> = {
  info_seeking: '정보 수집형',
  info_expanding: '정보 확장형',
  application_expanding: '적용 확장형',
  connecting: '연결형',
  reflective: '반성적·성찰적'
}

/** Tailwind classes (background, border, text) per type. */
export const QUESTION_TYPE_CLASS: Record<QuestionType, string> = {
  info_seeking: 'bg-blue-100 border-blue-400 text-blue-900',
  info_expanding: 'bg-teal-100 border-teal-400 text-teal-900',
  application_expanding: 'bg-orange-100 border-orange-400 text-orange-900',
  connecting: 'bg-violet-100 border-violet-400 text-violet-900',
  reflective: 'bg-rose-100 border-rose-400 text-rose-900'
}

/** Muted hex colors per type, used for the bubble mind map branches. */
export const QUESTION_TYPE_COLOR: Record<QuestionType, string> = {
  info_seeking: '#6f8fae',
  info_expanding: '#4f8a8b',
  application_expanding: '#c27a63',
  connecting: '#9d7fa6',
  reflective: '#c48a92'
}

/** Fixed display order for type trees. */
export const QUESTION_TYPE_CODES: QuestionType[] = [
  'info_seeking',
  'info_expanding',
  'application_expanding',
  'connecting',
  'reflective'
]

export const UNCLASSIFIED_TYPE_CLASS = 'bg-gray-100 border-gray-300 text-gray-700'

export function questionTypeLabel(code: QuestionType | null | undefined): string {
  return t(code ? QUESTION_TYPE_LABEL[code] : '미분류')
}

export function questionTypeClass(code: QuestionType | null | undefined): string {
  return code ? QUESTION_TYPE_CLASS[code] : UNCLASSIFIED_TYPE_CLASS
}
