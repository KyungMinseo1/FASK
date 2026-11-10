import test from 'node:test'
import assert from 'node:assert/strict'
import { PROMPTS, prompt, type PromptName } from '../src/main/prompts'

const holes = (s: string): string[] =>
  [...new Set([...s.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))].sort()

test('Korean and English prompts define the same placeholders', () => {
  for (const name of Object.keys(PROMPTS.ko) as PromptName[]) {
    assert.ok(PROMPTS.en[name].trim(), name)
    assert.deepEqual(holes(PROMPTS.en[name]), holes(PROMPTS.ko[name]), name)
  }
})

test('prompt fills each placeholder once and rejects a missing value', () => {
  assert.ok(prompt('ko', 'answer', { project: '{{project}}' }).endsWith('프로젝트: {{project}}.'))
  assert.throws(() => prompt('en', 'answer'), /en\/answer needs \{\{project\}\}/)
})
