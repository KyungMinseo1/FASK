import { useState } from 'react'
import { overlayPreviewAvailable, previewOverlay, syncOverlayTheme } from '../overlay/control'
import { errorText } from '@desktop/renderer/src/personal/common'
import { useNavigate } from 'react-router'
import { readTheme, setTheme, type ThemePref } from '@desktop/renderer/src/personal/theme'
import { useMobile } from '../context'
import { RELAY_ADDRESS } from '../transport'

export default function Connection(): React.JSX.Element {
  const { data, pairing, client, conn, unpair } = useMobile()
  const navigate = useNavigate()
  const [theme, setThemeState] = useState(readTheme)
  const [previewError, setPreviewError] = useState('')
  const profile = data.profiles.find((p) => p.id === data.activeProfileId)
  return (
    <>
      <header className="mobile-top">
        <button aria-label="뒤로" onClick={() => navigate(-1)}>
          ←
        </button>
        <h1>연결</h1>
        <span />
      </header>
      <main className="mobile-body mobile-connection-screen">
        <dl className="mobile-connection">
          <dt>연결 주소</dt>
          <dd>
            {client.address() === RELAY_ADDRESS ? '중계 서버' : `${client.address()}:${pairing.port}`}
          </dd>
          <dt>상태</dt>
          <dd>
            {conn.state === 'online' ? '연결됨' : conn.state === 'offline' ? '오프라인' : '차단됨'}
          </dd>
          <dt>PC 프로필</dt>
          <dd>{profile?.name ?? '-'}</dd>
          <dt>AI 모델</dt>
          <dd>{data.settings.model || '설정되지 않음'}</dd>
        </dl>
        <label className="mobile-field">
          테마
          <select
            value={theme}
            onChange={(e) => {
              const v = e.target.value as ThemePref
              setThemeState(v)
              setTheme(v)
              syncOverlayTheme(v)
            }}
          >
            <option value="system">시스템 설정 따르기</option>
            <option value="light">라이트</option>
            <option value="dark">다크</option>
          </select>
        </label>
        {overlayPreviewAvailable() && (
          <>
            <button onClick={() => void previewOverlay().catch((e) => setPreviewError(errorText(e)))}>
              오버레이 미리보기 (테스트)
            </button>
            {previewError && (
              <p className="notice error" role="alert">
                {previewError}
              </p>
            )}
          </>
        )}
        <button className="danger" onClick={() => void unpair('연결을 해제했습니다.')}>
          연결 해제
        </button>
      </main>
    </>
  )
}
