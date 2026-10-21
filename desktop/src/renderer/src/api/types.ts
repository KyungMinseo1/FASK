// Legacy classroom REST contract, preserved with server/app/schemas.py.
// The personal app uses preload IPC; its shared wire types are re-exported here.
export type {
  AskInput,
  CapturePreview,
  CaptureRect,
  CaptureRegion,
  Concept,
  DisplayInfo,
  LocalSettings,
  PersonalApi,
  Profile,
  Project,
  Question,
  Snapshot,
  StreamEvent,
  Workspace
} from '../../../preload/personal'
// Legacy datetimes are ISO strings with `Z`.

export type Role = 'student' | 'teacher'

export interface UserOut {
  id: number
  email: string
  name: string
  role: Role
}

export interface AuthOut {
  token: string
  user: UserOut
}

export type QuestionType =
  'info_seeking' | 'info_expanding' | 'application_expanding' | 'connecting' | 'reflective'

export type SyllabusStatus = 'none' | 'parsing' | 'done' | 'failed'
export type GenStatus = 'idle' | 'running' | 'done' | 'failed'
export type GenSource = 'none' | 'material' | 'web' | 'llm'
export type NodeSource = 'syllabus' | 'material' | 'web' | 'llm' | 'manual'
export type MaterialStatus = 'processing' | 'done' | 'failed'
export type SessionStatus = 'open' | 'closed'
export type StudentQuestionStatus = 'pending' | 'classified' | 'failed'

export interface SessionOut {
  id: number
  course_id: number
  course_name: string
  week_id: number
  week_no: number
  week_title: string
  code: string
  status: SessionStatus
  opened_at: string
  closed_at: string | null
}

export interface CourseOut {
  id: number
  name: string
  code: string | null
  semester: string | null
  syllabus_filename: string | null
  syllabus_status: SyllabusStatus
  syllabus_error: string | null
  created_at: string
  /** Week of the most recent session (by opened_at), null if none. */
  last_session_week_id: number | null
}

export interface CourseSummary {
  id: number
  name: string
  code: string | null
  semester: string | null
  week_count: number
  question_count: number
  open_session: SessionOut | null
}

export interface MaterialOut {
  id: number
  filename: string
  kind: 'pdf' | 'pptx'
  status: MaterialStatus
  error: string | null
  page_count: number
}

export interface NodeOut {
  id: number
  parent_id: number | null
  title: string
  summary: string
  source: NodeSource
  edited: boolean
  position: number
  question_count: number
}

export interface WeekOut {
  id: number
  week_no: number
  title: string
  description: string
  is_lecture: boolean
  gen_status: GenStatus
  gen_source: GenSource
  gen_error: string | null
  materials: MaterialOut[]
  nodes: NodeOut[]
}

export interface GraphOut {
  course: CourseOut
  weeks: WeekOut[]
  open_session: SessionOut | null
}

export interface BannedWordOut {
  id: number
  word: string
}

export interface WeekRef {
  id: number
  week_no: number
  title: string
}

export interface PathItem {
  id: number
  title: string
}

export interface TeacherQuestionOut {
  id: number
  session_id: number
  session_week_no: number
  assigned_week: WeekRef
  concept_path: PathItem[]
  question_type: QuestionType | null
  keyword: string
  refined_text: string
  off_week: boolean
  created_at: string
  classified_at: string
}

export interface RefineOut {
  status: 'ok' | 'blocked'
  refined_text: string | null
  reason: string | null
}

export interface StudentQuestionOut {
  id: number
  course: { id: number; name: string }
  session_week: WeekRef
  assigned_week: WeekRef | null
  concept_path: PathItem[]
  question_type: QuestionType | null
  keyword: string | null
  status: StudentQuestionStatus
  raw_text: string
  refined_text: string
  has_capture: boolean
  off_week: boolean
  created_at: string
  memo: string
  recall_due_at: string
  recall_answer: string | null
  recall_answered_at: string | null
}

export interface SessionSummary extends SessionOut {
  question_count: number
}

export type LiveMessage =
  | { type: 'question.created'; question: TeacherQuestionOut }
  | { type: 'question.updated'; question: TeacherQuestionOut }
  | { type: 'session.closed' }
