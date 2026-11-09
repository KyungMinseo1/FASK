import type { CaptureSetupReason, DisplayInfo } from '../preload/personal'

export function selectCaptureDisplay(
  displays: readonly DisplayInfo[],
  preferredId: number | undefined
): number | undefined {
  if (preferredId !== undefined && displays.some((display) => display.id === preferredId)) {
    return preferredId
  }
  return displays.length === 1 ? displays[0].id : undefined
}

export function captureSetupMessage(reason: CaptureSetupReason): string {
  switch (reason) {
    case 'no-displays':
      return '연결된 모니터가 없습니다. 모니터를 연결한 뒤 다시 검색해 주세요.'
    case 'display-missing':
      return '모니터 연결이 달라졌습니다. 캡처 영역을 다시 설정해 주세요.'
    case 'display-selection-required':
      return '모니터를 선택해 주세요.'
    case 'region-changed':
      return '화면 크기 또는 캡처 대상이 바뀌었습니다. 캡처 영역을 다시 설정해 주세요.'
  }
}
