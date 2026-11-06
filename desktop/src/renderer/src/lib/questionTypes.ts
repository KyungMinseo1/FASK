import type { QuestionType } from '../api/types'

export const QUESTION_TYPE_LABEL: Record<QuestionType, string> = {
  info_seeking: '정보 수집형',
  info_expanding: '정보 확장형',
  application_expanding: '적용 확장형',
  connecting: '연결형',
  reflective: '반성적·성찰적'
}

/** Fixed display order for type trees. */
export const QUESTION_TYPE_CODES: QuestionType[] = [
  'info_seeking',
  'info_expanding',
  'application_expanding',
  'connecting',
  'reflective'
]
