import { useState } from 'react'
import { overlayPreviewAvailable, previewOverlay, syncOverlayTheme } from '../overlay/control'
import { errorText } from '@desktop/renderer/src/personal/common'
import { useNavigate } from 'react-router'
import {
  readTheme,
  setTheme,
  THEME_OPTIONS,
  themeBase,
  type ThemePref
} from '@desktop/renderer/src/personal/theme'
import { useMobile } from '../context'
import { RELAY_ADDRESS } from '../transport'

const STATE_LABEL = { online: '연결됨', offline: '오프라인', blocked: '차단됨' } as const

export default function Settings(): React.JSX.Element {
  const { data, pairing, client, conn, unpair } = useMobile()
  const navigate = useNavigate()
  const [theme, setThemeState] = useState(readTheme)
  const [previewError, setPreviewError] = useState('')
  const profile = data.profiles.find((p) => p.id === data.activeProfileId)
  const relayed = client.address() === RELAY_ADDRESS
  return (
    <>
      <header className="mobile-top">
        <button aria-label="뒤로" onClick={() => navigate(-1)}>
          ←
        </button>
        <h1>설정</h1>
        <span />
      </header>
      <main className="mobile-body mobile-settings">
        <section>
          <h2>화면 테마</h2>
          <p>이 휴대폰에만 적용되며 바로 바뀝니다.</p>
          <div className="theme-grid" role="radiogroup" aria-label="테마">
            {THEME_OPTIONS.map((o) => (
              <button
                key={o.value}
                role="radio"
                aria-checked={theme === o.value}
                className={`theme-chip theme-${o.value}${theme === o.value ? ' on' : ''}`}
                onClick={() => {
                  setThemeState(o.value)
                  setTheme(o.value as ThemePref)
                  syncOverlayTheme(themeBase(o.value))
                }}
              >
                <i aria-hidden />
                {o.label}
              </button>
            ))}
          </div>
        </section>
        <section>
          <h2>PC 연결</h2>
          <dl className="settings-rows">
            <div>
              <dt>상태</dt>
              <dd>
                <span className={`status-pill ${conn.state === 'online' ? 'online' : conn.state}`}>
                  {STATE_LABEL[conn.state]}
                </span>
              </dd>
            </div>
            <div>
              <dt>연결 경로</dt>
              <dd>{relayed ? '중계 서버' : `${client.address()}:${pairing.port}`}</dd>
            </div>
            <div>
              <dt>PC 프로필</dt>
              <dd>{profile?.name ?? '-'}</dd>
            </div>
            <div>
              <dt>AI 모델</dt>
              <dd>{data.settings.model || '설정되지 않음'}</dd>
            </div>
          </dl>
          <button className="danger" onClick={() => void unpair('연결을 해제했습니다.')}>
            연결 해제
          </button>
        </section>
        {overlayPreviewAvailable() && (
          <section>
            <h2>테스트</h2>
            <button onClick={() => void previewOverlay().catch((e) => setPreviewError(errorText(e)))}>
              오버레이 미리보기
            </button>
            {previewError && (
              <p className="notice error" role="alert">
                {previewError}
              </p>
            )}
          </section>
        )}
      </main>
    </>
  )
}
