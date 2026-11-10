import { useState } from 'react'
import {
  overlayPreviewAvailable,
  previewOverlay,
  syncOverlayAnswerBlink,
  syncOverlayLanguage,
  syncOverlayTheme
} from '../overlay/control'
import { errorText } from '@desktop/renderer/src/personal/common'
import { useNavigate } from 'react-router'
import {
  readTheme,
  setTheme,
  THEME_OPTIONS,
  FONT_SCALE_OPTIONS,
  readFontScale,
  setFontScale,
  type ThemePref
} from '@desktop/renderer/src/personal/theme'
import { readAnswerBlink, setAnswerBlink } from '@desktop/renderer/src/personal/answer-blink'
import {
  LANGUAGE_OPTIONS,
  readLanguage,
  resolveLanguage,
  setLanguage,
  type LanguagePref
} from '@desktop/shared/i18n'
import { useT } from '@desktop/shared/i18n/react'
import { useMobile } from '../context'
import { RELAY_ADDRESS } from '../transport'
import { demoAvailable } from '../demo-hub'
import { Icon } from '../icons'

const STATE_LABEL = { online: '연결됨', offline: '오프라인', blocked: '차단됨' } as const
const MEMORY_SCOPE_LABEL = { off: '끄기', project: '현재 프로젝트', workspace: '워크스페이스' } as const

/** Mobile kit order: system first, then light themes from plainest to most tinted, night last. */
const THEME_ORDER = ['system', 'white', 'ivory', 'navy', 'lavender', 'night']
const MOBILE_THEMES = [...THEME_OPTIONS].sort((a, b) => THEME_ORDER.indexOf(a.value) - THEME_ORDER.indexOf(b.value))

/** Fixed swatches (page, primary): each previews its theme regardless of the active one. */
const SWATCH: Record<string, readonly [string, string]> = {
  system: ['#FFFFFF', '#0B0B0B'],
  navy: ['#F4EDE0', '#14213D'],
  white: ['#FFFFFF', '#0B0B0C'],
  ivory: ['#F3ECDD', '#1F3D2B'],
  lavender: ['#E7DAF5', '#3B2160'],
  night: ['#0B0B0B', '#D4FF3F']
}

function Swatch({ theme }: { theme: string }): React.JSX.Element | null {
  const colors = SWATCH[theme]
  if (!colors) return null
  return (
    <svg className="theme-swatch" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M17.07 2.93A10 10 0 0 0 2.93 17.07z" fill={colors[0]} />
      <path d="M17.07 2.93A10 10 0 0 1 2.93 17.07z" fill={colors[1]} />
      <circle cx="10" cy="10" r="9.5" fill="none" stroke="currentColor" strokeOpacity=".3" />
    </svg>
  )
}

export default function Settings(): React.JSX.Element {
  const { data, pairing, client, conn, unpair, demo, enterDemo } = useMobile()
  const navigate = useNavigate()
  const t = useT()
  const [theme, setThemeState] = useState(readTheme)
  const [answerBlink, setAnswerBlinkState] = useState(readAnswerBlink)
  const [language, setLanguageState] = useState<LanguagePref>(readLanguage)
  const [fontScale, setFontScaleState] = useState(readFontScale)
  const [previewError, setPreviewError] = useState('')
  const profile = data.profiles.find((p) => p.id === data.activeProfileId)
  const relayed = client.address() === RELAY_ADDRESS
  return (
    <>
      <header className="mobile-top">
        <button aria-label={t('뒤로')} onClick={() => navigate(-1)}>
          <Icon name="back" />
        </button>
        <h1>{t('설정')}</h1>
        <span />
      </header>
      <main className="mobile-body mobile-settings">
        <section>
          <h2>{t('화면 테마')}</h2>
          <p>{t('이 휴대폰에만 적용되며 바로 바뀝니다.')}</p>
          <div className="theme-grid" role="radiogroup" aria-label={t('테마')}>
            {MOBILE_THEMES.map((o) => (
              <button
                key={o.value}
                role="radio"
                aria-checked={theme === o.value}
                className={`theme-chip${theme === o.value ? ' on' : ''}`}
                onClick={() => {
                  setThemeState(o.value)
                  setTheme(o.value as ThemePref)
                  syncOverlayTheme(o.value)
                }}
              >
                <Swatch theme={o.value} />
                {t(o.label)}
              </button>
            ))}
          </div>
        </section>
        <section>
          <h2>{t('토글 알림')}</h2>
          <label className="check">
            <input
              type="checkbox"
              checked={answerBlink}
              onChange={(e) => {
                setAnswerBlinkState(e.target.checked)
                setAnswerBlink(e.target.checked)
                syncOverlayAnswerBlink(e.target.checked)
              }}
            />
            {t('답변 완료 시 토글 로고 깜빡임')}
          </label>
        </section>
        <section>
          <h2>{t('언어')}</h2>
          <p>{t('이 휴대폰에만 적용되며 바로 바뀝니다.')}</p>
          <div className="theme-grid" role="radiogroup" aria-label={t('언어')}>
            {LANGUAGE_OPTIONS.map((o) => (
              <button
                key={o.value}
                role="radio"
                aria-checked={language === o.value}
                className={`theme-chip${language === o.value ? ' on' : ''}`}
                onClick={() => {
                  setLanguageState(o.value)
                  setLanguage(o.value)
                  syncOverlayLanguage(resolveLanguage())
                }}
              >
                {o.value === 'system' ? t(o.label) : o.label}
              </button>
            ))}
          </div>
        </section>
        <section>
          <h2>{t('글꼴 크기')}</h2>
          <div className="theme-grid" role="radiogroup" aria-label={t('글꼴 크기')}>
            {FONT_SCALE_OPTIONS.map((o) => (
              <button
                key={o.value}
                role="radio"
                aria-checked={fontScale === o.value}
                className={`theme-chip${fontScale === o.value ? ' on' : ''}`}
                onClick={() => {
                  setFontScaleState(o.value)
                  setFontScale(o.value)
                }}
              >
                {t(o.label)}
              </button>
            ))}
          </div>
        </section>
        <section>
          <h2>{t('PC 연결')}</h2>
          <dl className="settings-rows">
            <div>
              <dt>{t('상태')}</dt>
              <dd>
                <span className={`status-pill ${conn.state === 'online' ? 'online' : conn.state}`}>
                  {t(STATE_LABEL[conn.state])}
                </span>
              </dd>
            </div>
            <div>
              <dt>{t('연결 경로')}</dt>
              <dd>{demo ? t('데모 (PC 없음)') : relayed ? t('중계 서버') : `${client.address()}:${pairing.port}`}</dd>
            </div>
            <div>
              <dt>{t('PC 프로필')}</dt>
              <dd>{profile?.name ?? '-'}</dd>
            </div>
            <div>
              <dt>{t('AI 모델')}</dt>
              <dd>{data.settings.model || t('설정되지 않음')}</dd>
            </div>
            <div>
              <dt>{t('AI 프롬프트 언어')}</dt>
              <dd>{data.settings.promptLanguage === 'en' ? 'English' : '한국어'}</dd>
            </div>
          </dl>
          <button className="danger" onClick={() => void unpair(demo ? '' : t('연결을 해제했습니다.'))}>
            {demo ? t('데모 종료') : t('연결 해제')}
          </button>
        </section>
        <section>
          <h2>{t('지식 활용')}</h2>
          <p>{t('PC의 FASK 설정에서 바꿀 수 있습니다.')}</p>
          <dl className="settings-rows">
            <div>
              <dt>{t('개념 정리')}</dt>
              <dd>{data.settings.organize ? t('켜짐') : t('꺼짐')}</dd>
            </div>
            <div>
              <dt>{t('개념 추출 대기')}</dt>
              <dd>{t('{{n}}초', { n: data.settings.extractDelaySec })}</dd>
            </div>
            <div>
              <dt>{t('질문에 참고할 지식')}</dt>
              <dd>{t(MEMORY_SCOPE_LABEL[data.settings.memoryScope])}</dd>
            </div>
            <div>
              <dt>{t('참고 토큰 상한')}</dt>
              <dd>{data.settings.memoryTokens.toLocaleString()}</dd>
            </div>
          </dl>
        </section>
        {(overlayPreviewAvailable() || (demoAvailable() && !demo)) && (
          <section>
            <h2>{t('테스트')}</h2>
            {demoAvailable() && !demo && <button onClick={enterDemo}>{t('PC 없이 데모로 둘러보기')}</button>}
            {overlayPreviewAvailable() && (
              <button onClick={() => void previewOverlay().catch((e) => setPreviewError(errorText(e)))}>
                {t('오버레이 미리보기')}
              </button>
            )}
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
