import test from 'node:test'
import assert from 'node:assert/strict'
import type { DisplayInfo } from '../src/preload/personal'
import { selectCaptureDisplay } from '../src/shared/capture'

const display = (id: number): DisplayInfo => ({
  id,
  label: `Monitor ${id}`,
  width: 1920,
  height: 1080
})

test('selectCaptureDisplay keeps a valid preferred monitor', () => {
  assert.equal(selectCaptureDisplay([display(1), display(2)], 2), 2)
})

test('selectCaptureDisplay keeps monitor ID zero', () => {
  assert.equal(selectCaptureDisplay([display(1), display(0)], 0), 0)
})

test('selectCaptureDisplay selects the sole monitor when the preferred ID is missing', () => {
  assert.equal(selectCaptureDisplay([display(2)], 99), 2)
  assert.equal(selectCaptureDisplay([display(2)], undefined), 2)
})

test('selectCaptureDisplay requires selection among multiple monitors when the preferred ID is missing', () => {
  assert.equal(selectCaptureDisplay([display(1), display(2)], 99), undefined)
  assert.equal(selectCaptureDisplay([display(1), display(2)], undefined), undefined)
})

test('selectCaptureDisplay returns no selection when no monitors are connected', () => {
  assert.equal(selectCaptureDisplay([], 1), undefined)
  assert.equal(selectCaptureDisplay([], undefined), undefined)
})
