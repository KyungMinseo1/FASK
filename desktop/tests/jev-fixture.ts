// Store fixtures shared by the fake-Jev unit tests and the live Jev test.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PersonalStore } from '../src/main/personal-store'
import type { Concept, Project, Question } from '../src/preload/personal'

let clock = 0
export function addQuestion(
  store: PersonalStore,
  id: string,
  projectId: string,
  sent: string,
  answer: string,
  options: { title?: string; conceptIds?: string[] } = {}
): void {
  const createdAt = new Date(Date.UTC(2026, 0, 1) + ++clock * 60000).toISOString()
  store.put<Question>('question', store.active, {
    id,
    projectId,
    createdAt,
    title: options.title ?? sent.slice(0, 100),
    turns: [
      {
        id: `${id}-t`,
        createdAt,
        raw: sent,
        refined: '',
        sent,
        answer,
        model: '',
        actualModel: '',
        status: 'completed',
        complexity: 'simple',
        routingReason: '',
        attachment: null,
        documents: [],
        error: '',
        revision: 0
      }
    ],
    conceptIds: options.conceptIds ?? [],
    conceptTurns: {},
    extractedTurns: 0,
    suggestions: [],
    memo: '',
    important: false
  })
}
export function withStore(run: (store: PersonalStore, ws: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'fask-jev-'))
  const store = new PersonalStore(dir)
  return run(store, store.list<Project>('project')[0].workspaceId).finally(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
}

/** DecisionRAG paper example: the answer is in a record sharing no keyword with the query. */
export const MOVIE_QUERY = '놀란 감독의 2000년 영화 주인공은 누구야?'
/**
 * Seven projects with more than BATCH_MAX leaves in total, so stage 1 runs. M ("메멘토 구조")
 * never mentions 놀란 or 2000; G ("글래디에이터(2000)") shares 2000 with the query. Q is the
 * question being answered and must stay out of every request.
 */
export function movieFixture(store: PersonalStore, ws: string): void {
  const project = (id: string, name: string): void => {
    store.put<Project>('project', store.active, { id, workspaceId: ws, name, description: '' })
  }
  const concept = (
    id: string,
    name: string,
    level: Concept['level'],
    parentId: string | null
  ): void => {
    store.put<Concept>('concept', store.active, {
      id,
      workspaceId: ws,
      name,
      parentId,
      manual: false,
      aliases: [],
      definition: '',
      level
    })
  }
  project('PM', '영화 노트')
  project('PH', '역사')
  concept('T', '영화 이론', 'topic', null)
  concept('C', '시간 역순 구성', 'concept', 'T')
  addQuestion(
    store,
    'M',
    'PM',
    '메멘토에서 레너드 셸비는 단기 기억상실을 앓는다. 이 영화의 역순 구조를 설명해줘',
    '레너드는 몇 분마다 기억을 잃기 때문에 문신과 폴라로이드 사진으로 아내를 죽인 범인을 쫓는다. 컬러 장면은 시간을 거슬러 진행하고 흑백 장면은 순서대로 진행하다가 마지막에 두 흐름이 만난다.',
    { title: '메멘토 구조', conceptIds: ['C'] }
  )
  addQuestion(store, 'M2', 'PM', '메멘토 OST 정리', '음악 감독과 수록곡 목록.')
  addQuestion(
    store,
    'G',
    'PH',
    '글래디에이터(2000) 정리',
    '로마 장군 막시무스가 검투사가 되어 황제에게 복수하는 이야기.'
  )
  for (let p = 1; p <= 5; p++) {
    project(`P${p}`, `생물 ${p}`)
    for (let i = 1; i <= 11; i++)
      addQuestion(
        store,
        `P${p}Q${i}`,
        `P${p}`,
        `세포 생물학 메모 ${p}-${i}`,
        '미토콘드리아는 세포의 에너지를 만든다.'
      )
  }
  addQuestion(store, 'Q', 'PM', '현재 질문 고유문구', '진행 중')
}
