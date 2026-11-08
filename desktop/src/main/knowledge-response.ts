import type { ConceptLevel, RelationType } from '../preload/personal'
import { CONCEPT_LEVELS, RELATION_TYPES } from './personal-backup'

/**
 * Strict validation of the extraction and tidy model responses. Every field is checked; an item
 * with an invalid field is dropped whole (never repaired or guessed), so a doubtful answer costs
 * only that item. Concept references are an id the model was sent (`known`), or a concept name;
 * an id-shaped string that was not sent is an unknown id. Unparseable extraction output is an
 * empty result; unparseable tidy output stays an error, since the dialog records an empty
 * proposal's candidates as reviewed.
 */

/** A concept reference after validation: a sent id or a sane name. */
type Ref = string

export interface ExtractedConcept {
  name: string
  existingId: string | null
  aliases: string[]
  definition: string
  level: ConceptLevel
  /** null: the model abstained (or the concept is a topic). */
  parent: Ref | null
  grandparent: Ref | null
  /** Turn indexes as given; the caller maps them to the batch. */
  turns: number[]
  confidence: number
}
export interface ExtractedRelation {
  from: Ref
  to: Ref
  type: RelationType
  confidence: number
}
export interface Extraction {
  concepts: ExtractedConcept[]
  relations: ExtractedRelation[]
}

export interface TidyResponse {
  merges: { source: string; target: string }[]
  levels: { id: string; level: ConceptLevel }[]
  parents: { name: string; level: ConceptLevel; parent: Ref | null; children: string[] }[]
  assign: { id: string; parentId: string }[]
  relations: { from: string; to: string; type: RelationType; confidence: number }[]
}

/** Store concept ids are UUIDs; such a string that was not sent is never taken as a name. */
const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ONLY_SYMBOLS = /^[\p{P}\p{S}\p{N}\s]+$/u
/** A question sentence copied as a name, not a concept. */
const QUESTION_LIKE = /[?？]$|어떻게|풀어/
const MAX_NAME = 60

/** Not valid: the item holding the field is dropped. */
const BAD = Symbol('invalid')
type Checked<T> = T | typeof BAD

/** A concept name: trimmed 1-60 chars, not only digits/punctuation, not a question sentence or an id. */
export function conceptName(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const s = v.trim()
  if (!s || s.length > MAX_NAME || ONLY_SYMBOLS.test(s) || QUESTION_LIKE.test(s) || ID_SHAPE.test(s))
    return undefined
  return s
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isLevel = (v: unknown): v is ConceptLevel => CONCEPT_LEVELS.includes(v as ConceptLevel)
const isType = (v: unknown): v is RelationType => RELATION_TYPES.includes(v as RelationType)
const isConfidence = (v: unknown): v is number => typeof v === 'number' && v >= 0 && v <= 1
const absent = (v: unknown): boolean => v === null || v === undefined
const knownId = (v: unknown, known: ReadonlySet<string>): v is string => typeof v === 'string' && known.has(v)

/** A sent id, else a sane name; null/absent is an abstention. */
function optionalRef(v: unknown, known: ReadonlySet<string>): Checked<Ref | null> {
  if (absent(v)) return null
  return ref(v, known)
}
function ref(v: unknown, known: ReadonlySet<string>): Checked<Ref> {
  if (knownId(v, known)) return v
  return conceptName(v) ?? BAD
}

/** The first JSON object in the text; undefined when there is none or it does not parse. */
function parseObject(text: string): Record<string, unknown> | undefined {
  const start = text.indexOf('{'),
    end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return undefined
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1))
    return isObject(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** Validates each element of `v` (absent or not an array: none); counts the dropped ones. */
function items<T>(v: unknown, check: (raw: Record<string, unknown>) => Checked<T>, dropped: Record<string, number>, key: string): T[] {
  if (!Array.isArray(v)) return []
  const out: T[] = []
  for (const raw of v) {
    const item = isObject(raw) ? check(raw) : BAD
    if (item === BAD) dropped[key] = (dropped[key] ?? 0) + 1
    else out.push(item)
  }
  return out
}

function report(what: string, dropped: Record<string, number>): void {
  const parts = Object.entries(dropped).map(([k, n]) => `${n} ${k}`)
  if (parts.length) console.debug(`[knowledge] ${what}: dropped invalid ${parts.join(', ')}`)
}

/** Extraction response; `known` holds the candidate and linked concept ids that were sent. */
export function parseExtraction(text: string, known: ReadonlySet<string>): Extraction {
  const parsed = parseObject(text)
  if (!parsed) {
    console.debug('[knowledge] extraction: unparseable response, treated as empty')
    return { concepts: [], relations: [] }
  }
  const dropped: Record<string, number> = {}
  const concepts = items(
    parsed.concepts,
    (raw): Checked<ExtractedConcept> => {
      const name = conceptName(raw.name)
      const existingId = absent(raw.existingId) ? null : knownId(raw.existingId, known) ? raw.existingId : BAD
      const parent = optionalRef(raw.parent, known),
        grandparent = optionalRef(raw.grandparent, known)
      const aliases = absent(raw.aliases) ? [] : Array.isArray(raw.aliases) ? raw.aliases : BAD
      const definition = absent(raw.definition) ? '' : typeof raw.definition === 'string' ? raw.definition : BAD
      const turns = absent(raw.turns) ? [] : Array.isArray(raw.turns) ? raw.turns : BAD
      if (
        !name ||
        existingId === BAD ||
        !isLevel(raw.level) ||
        parent === BAD ||
        grandparent === BAD ||
        aliases === BAD ||
        definition === BAD ||
        turns === BAD ||
        !isConfidence(raw.confidence)
      )
        return BAD
      return {
        name,
        existingId,
        aliases: aliases.flatMap((a) => conceptName(a) ?? []),
        definition: definition.trim().slice(0, 1000),
        level: raw.level,
        parent,
        grandparent,
        turns: turns.filter((i): i is number => Number.isInteger(i)),
        confidence: raw.confidence
      }
    },
    dropped,
    'concepts'
  )
  const relations = items(
    parsed.relations,
    (raw): Checked<ExtractedRelation> => {
      const from = ref(raw.from, known),
        to = ref(raw.to, known)
      if (from === BAD || to === BAD || !isType(raw.type) || !isConfidence(raw.confidence)) return BAD
      return { from, to, type: raw.type, confidence: raw.confidence }
    },
    dropped,
    'relations'
  )
  report('extraction', dropped)
  return { concepts, relations }
}

/** Tidy response; `known` holds the concept and topic ids the plan sent. */
export function parseTidy(text: string, known: ReadonlySet<string>): TidyResponse {
  const parsed = parseObject(text)
  if (!parsed) throw new Error('모델이 JSON을 반환하지 않았습니다.')
  const dropped: Record<string, number> = {}
  const id = (v: unknown): v is string => knownId(v, known)
  const merges = items(
    parsed.merges,
    (raw) => (id(raw.source) && id(raw.target) ? { source: raw.source, target: raw.target } : BAD),
    dropped,
    'merges'
  )
  const levels = items(
    parsed.levels,
    (raw) => (id(raw.id) && isLevel(raw.level) ? { id: raw.id, level: raw.level } : BAD),
    dropped,
    'levels'
  )
  const parents = items(
    parsed.parents,
    (raw): Checked<TidyResponse['parents'][number]> => {
      const name = conceptName(raw.name)
      const parent = optionalRef(raw.parent, known)
      if (!name || !isLevel(raw.level) || parent === BAD || !Array.isArray(raw.children)) return BAD
      const children = raw.children.filter(id)
      const unknown = raw.children.length - children.length
      if (unknown) dropped['parent children'] = (dropped['parent children'] ?? 0) + unknown
      return children.length ? { name, level: raw.level, parent, children } : BAD
    },
    dropped,
    'parents'
  )
  const assign = items(
    parsed.assign,
    (raw) => (id(raw.id) && id(raw.parentId) ? { id: raw.id, parentId: raw.parentId } : BAD),
    dropped,
    'assign'
  )
  const relations = items(
    parsed.relations,
    (raw): Checked<TidyResponse['relations'][number]> =>
      id(raw.from) && id(raw.to) && isType(raw.type) && isConfidence(raw.confidence)
        ? { from: raw.from, to: raw.to, type: raw.type, confidence: raw.confidence }
        : BAD,
    dropped,
    'relations'
  )
  report('tidy', dropped)
  return { merges, levels, parents, assign, relations }
}
