// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import Settings from '@desktop/renderer/src/personal/Settings'
import type { CaptureRegionSaved, LocalSettings, PersonalApi } from '@desktop/preload/personal'

afterEach(cleanup)
it('clears a locally raised capture issue after a successful retry apply', async () => {
  const listeners = new Set<(event: CaptureRegionSaved) => void>()
  const open = vi.fn().mockResolvedValueOnce({ ok: false, reason: 'region-changed' }).mockResolvedValue({ ok: true })
  const api = {
    displays: async () => [{ id: 1, label: 'Monitor', width: 800, height: 600 }],
    openCaptureEditor: open,
    onChanged: () => () => {},
    onCaptureRegionSaved: (cb: (event: CaptureRegionSaved) => void) => { listeners.add(cb); return () => listeners.delete(cb) },
    peerCodeStatus: async () => null,
    peerGrants: async () => [], peerLinks: async () => [], hubStatus: async () => null
  }
  window.fask = api as unknown as PersonalApi
  render(<Settings settings={{ endpoint: 'http://localhost', model: 'm', models: ['m'], regions: [] } as unknown as LocalSettings} onClose={() => {}} />)
  await act(async () => { await Promise.resolve() })
  await act(async () => fireEvent.click(screen.getByText('캡처 영역 설정')))
  expect(screen.getByText('화면 크기 또는 캡처 대상이 바뀌었습니다. 캡처 영역을 다시 설정해 주세요.')).toBeTruthy()
  await act(async () => fireEvent.click(screen.getByText('캡처 영역 설정')))
  await act(async () => listeners.forEach(cb => cb({ overlayChanged: false, region: { displayId: 1, screenWidth: 800, screenHeight: 600, rect: { x: 0, y: 0, width: 1, height: 1 } } })))
  expect(screen.queryByText('화면 크기 또는 캡처 대상이 바뀌었습니다. 캡처 영역을 다시 설정해 주세요.')).toBeNull()
})
