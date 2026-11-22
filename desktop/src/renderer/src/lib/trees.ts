export type MindNodeKind = 'root' | 'week' | 'topic' | 'concept' | 'type' | 'group' | 'question'

export interface MindNode {
  id: string
  label: string
  kind: MindNodeKind
  count?: number
  detail?: string
  badge?: string
  /** Questions attached directly to this concept per the server (known even when leaves are hidden). */
  ownQuestions?: number
  /** True when this node's subtree holds at least one student question. */
  hasQuestions?: boolean
  children: MindNode[]
}
