import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import type {
  CaptureSetupReason,
  DisplayInfo,
  Habit,
  HabitInput,
  HabitList,
  HubStatus,
  LocalSettings,
  ManagerState,
  PeerCode,
  PeerGrantInfo,
  PeerLinkInfo,
  PeerStatus
} from '../../../preload/personal'
import { captureSetupMessage, selectCaptureDisplay } from '../../../shared/capture'
import { errorText } from './common'
import { Icon, type IconName } from './ToolbarIcons'
import {
  FONT_SCALE_OPTIONS,
  readFontScale,
  readTheme,
  setFontScale,
  setTheme,
  THEME_OPTIONS,
  type FontScale,
  type ThemePref
} from './theme'
import { readAnswerBlink, setAnswerBlink } from './answer-blink'
import { LANGUAGE_OPTIONS, readLanguage, resolveLanguage, setLanguage, type LanguagePref } from '../../../shared/i18n'
import { useT } from '../../../shared/i18n/react'

export type SettingsCategory = 'ai' | 'questions' | 'capture' | 'display' | 'devices' | 'data'

const CATEGORIES: { id: SettingsCategory; label: string; icon: IconName }[] = [
  { id: 'ai', label: 'AI 연결', icon: 'plug' },
  { id: 'questions', label: '질문과 지식', icon: 'book' },
  { id: 'capture', label: '화면 캡처', icon: 'scan' },
  { id: 'display', label: '화면 표시', icon: 'contrast' },
  { id: 'devices', label: '기기 연결', icon: 'devices' },
  { id: 'data', label: '데이터', icon: 'database' }
]

/** Model slots in fallback order; descriptions follow where main/renderer pick each one. */
const MODEL_ROLES: {
  field: 'model' | 'fastModel' | 'deepModel' | 'organizeModel'
  label: string
  description: string
  placeholder?: string
  icon: IconName
}[] = [
  {
    field: 'model',
    label: '기본 모델',
    description: '질문에 답할 때 쓰는 기본 모델입니다. 다른 칸을 비워 두면 대신 쓰입니다.',
    icon: 'modelBase'
  },
  {
    field: 'fastModel',
    label: '빠른 모델',
    description: '간단한 질문, 질문 다듬기, 제목과 검색어 생성처럼 가벼운 작업에 씁니다.',
    placeholder: '기본 모델 사용',
    icon: 'modelFast'
  },
  {
    field: 'deepModel',
    label: '깊은 추론 모델',
    description: '증명, 설계, 분석처럼 복잡한 질문에 추천하거나 자동으로 고릅니다.',
    placeholder: '기본 모델 사용',
    icon: 'modelDeep'
  },
  {
    field: 'organizeModel',
    label: '개념 정리 모델',
    description: '답변에서 개념을 뽑고 개념 지도를 정리할 때 씁니다.',
    placeholder: '빠른 모델 사용',
    icon: 'modelOrganize'
  }
]

export default function Settings({
  settings,
  onClose,
  initialCategory = 'ai',
  captureIssue,
  variant = 'page'
}: {
  settings: LocalSettings
  onClose: () => void
  initialCategory?: SettingsCategory
  captureIssue?: CaptureSetupReason
  variant?: 'page' | 'capture'
}): React.JSX.Element {
  const [draft, setDraft] = useState(settings),
    [key, setKey] = useState<string | undefined>(),
    [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [selectedDisplayId, setSelectedDisplayId] = useState<number | undefined>(),
    [refreshingDisplays, setRefreshingDisplays] = useState(true),
    [displayError, setDisplayError] = useState(''),
    [editing, setEditing] = useState(false)
  const [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false)
  const [captureReason, setCaptureReason] = useState(captureIssue)
  const captureSection = useRef<HTMLElement>(null)
  const captureDisplay = useRef<HTMLSelectElement>(null)
  const captureFocusPending = useRef(false)
  const displayRequest = useRef(0)
  const currentDisplays = useRef<DisplayInfo[]>([])
  const preferredDisplayId = useRef(settings.displayId)
  const savedDisplayId = useRef(settings.displayId)
  const editingRef = useRef(false)
  const mounted = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [category, setCategory] = useState<SettingsCategory>(variant === 'capture' ? 'capture' : initialCategory)
  const shown = variant === 'capture' ? 'capture' : category
  const [theme, setThemeState] = useState(readTheme)
  const [answerBlink, setAnswerBlinkState] = useState(readAnswerBlink)
  const [language, setLanguageState] = useState(readLanguage)
  const [fontScale, setFontScaleState] = useState(readFontScale)
  const t = useT()
  const share = usePeerCode()
  const refreshDisplays = useCallback(async (): Promise<{ displayId: number | undefined } | null> => {
    const request = ++displayRequest.current
    setRefreshingDisplays(true)
    setDisplayError('')
    try {
      const next = await window.fask.displays()
      if (!mounted.current || request !== displayRequest.current) return null
      const displayId = selectCaptureDisplay(next, preferredDisplayId.current)
      currentDisplays.current = next
      if (displayId !== undefined) preferredDisplayId.current = displayId
      setDisplays(next)
      setSelectedDisplayId(displayId)
      return { displayId }
    } catch (e) {
      if (mounted.current && request === displayRequest.current) {
        currentDisplays.current = []
        setDisplays([])
        setSelectedDisplayId(undefined)
        setDisplayError(errorText(e))
      }
      return null
    } finally {
      if (mounted.current && request === displayRequest.current) setRefreshingDisplays(false)
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    const onFocus = (): void => {
      if (!editingRef.current) void refreshDisplays()
    }
    window.addEventListener('focus', onFocus)
    void refreshDisplays()
    return () => {
      mounted.current = false
      ++displayRequest.current
      window.removeEventListener('focus', onFocus)
    }
  }, [refreshDisplays])
  useEffect(() => {
    if (savedDisplayId.current === settings.displayId) return
    savedDisplayId.current = settings.displayId
    preferredDisplayId.current = settings.displayId
    const displayId = selectCaptureDisplay(currentDisplays.current, settings.displayId)
    if (displayId !== undefined) preferredDisplayId.current = displayId
    setSelectedDisplayId(displayId)
  }, [settings.displayId])
  useEffect(() => {
    setCaptureReason(captureIssue)
  }, [captureIssue])
  useEffect(() => window.fask.onCaptureRegionSaved(() => {
    setCaptureReason(undefined)
  }), [])
  useEffect(() => {
    if (variant !== 'capture' && initialCategory !== 'capture') return
    setCategory('capture')
    captureSection.current?.scrollIntoView({ block: 'start' })
    captureFocusPending.current = true
  }, [variant, initialCategory, captureIssue])
  useEffect(() => {
    if (!captureFocusPending.current || refreshingDisplays || editing || !captureDisplay.current) return
    captureDisplay.current.focus({ preventScroll: true })
    captureFocusPending.current = false
  }, [refreshingDisplays, editing, category, captureIssue, captureReason])
  useEffect(() => scrollRef.current?.scrollTo({ top: 0 }), [category])
  const change = <K extends keyof LocalSettings>(name: K, value: LocalSettings[K]): void =>
    setDraft((s) => ({ ...s, [name]: value }))
  const run = async (fn: () => Promise<unknown>, message: string): Promise<void> => {
    setBusy(true)
    setNotice('')
    try {
      await fn()
      setNotice(message)
    } catch (e) {
      setNotice(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const save = async (): Promise<void> => {
    await window.fask.saveSettings(draft, key)
  }
  const close = (): void => {
    if (!editingRef.current) onClose()
  }
  const editCaptureRegion = async (): Promise<void> => {
    if (editingRef.current || busy || refreshingDisplays || displayError || selectedDisplayId === undefined)
      return
    editingRef.current = true
    setEditing(true)
    setNotice('')
    try {
      const next = await refreshDisplays()
      if (!next) return
      if (next.displayId === undefined) {
        if (currentDisplays.current.length) setNotice(t('모니터를 선택해 주세요.'))
        return
      }
      const result = await window.fask.openCaptureEditor(next.displayId)
      if (!result.ok && mounted.current) {
        setCaptureReason(result.reason)
        captureFocusPending.current = true
        captureSection.current?.scrollIntoView({ block: 'start' })
        await refreshDisplays()
      }
    } catch (e) {
      if (mounted.current) setNotice(errorText(e))
    } finally {
      editingRef.current = false
      if (mounted.current) setEditing(false)
    }
  }
  const shownLabel = t(CATEGORIES.find((c) => c.id === shown)!.label)
  const aiContent = (
    <>
      <section>
        <h3>{t('로컬 AI 연결')}</h3>
        <p>{t('OpenAI compatible API의 주소를 붙여넣으세요.')}</p>
        <label>
          {t('로컬 API 주소')}
          <input
            value={draft.endpoint}
            onChange={(e) => change('endpoint', e.target.value)}
            placeholder="http://127.0.0.1:8317/v1"
          />
        </label>
        <label>
          {t('로컬 접속 키')}
          <input
            type="password"
            value={key ?? ''}
            onChange={(e) => setKey(e.target.value)}
            placeholder={
              settings.hasKey ? t('저장된 키 사용 중, 바꾸려면 입력') : t('프록시가 요구하는 경우에만 입력')
            }
          />
        </label>
        {settings.hasKey && <button onClick={() => setKey('')}>{t('저장된 키 제거')}</button>}
        <button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const models = await window.fask.models(draft.endpoint, key)
              setDraft((s) => ({ ...s, models, model: s.model || models[0] || '' }))
              if (!models.length)
                throw new Error(t('연결됐지만 모델이 없습니다. 프록시에서 계정을 연결해 주세요.'))
            }, t('연결을 확인하고 모델 목록을 갱신했습니다. 저장을 눌러 적용하세요.'))
          }
        >
          <Icon name="key" />
          {busy ? t('확인 중…') : t('연결 확인하고 모델 불러오기')}
        </button>
        <small>
          {t(
            '접속 키는 OS 저장소로 암호화합니다. 공급자 로그인, 계정, 폴백 설정은 OpenAI compatible API에서 관리하세요.'
          )}
        </small>
      </section>
      <section>
        <h3>{t('모델')}</h3>
        <datalist id="local-models">
          {draft.models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        <div className="model-roles">
          {MODEL_ROLES.map((r) => (
            <label key={r.field} className="model-role">
              <span className="model-role-art">
                <Icon name={r.icon} size={22} />
              </span>
              <span className="model-role-text">
                <b>{t(r.label)}</b>
                <small>{t(r.description)}</small>
              </span>
              <input
                list="local-models"
                value={draft[r.field]}
                onChange={(e) => change(r.field, e.target.value)}
                placeholder={r.placeholder && t(r.placeholder)}
              />
            </label>
          ))}
        </div>
      </section>
    </>
  )
  const questionsContent = (
    <>
      <section>
        <h3>{t('질문 처리')}</h3>
        <label>
          {t('AI 프롬프트 언어')}
          <select
            value={draft.promptLanguage}
            onChange={(e) => change('promptLanguage', e.target.value as LocalSettings['promptLanguage'])}
          >
            <option value="ko">한국어</option>
            <option value="en">English</option>
          </select>
        </label>
        <small>
          {t('모델에게 보내는 지시문의 언어입니다. 화면 언어와 따로 정하며, 답변과 개념 이름은 대화에 쓰인 언어를 따릅니다.')}
        </small>
        <label>
          {t('모델 선택')}
          <select
            value={draft.routing}
            onChange={(e) => change('routing', e.target.value as LocalSettings['routing'])}
          >
            <option value="manual">{t('직접 선택')}</option>
            <option value="recommend">{t('추천 표시, 전송 전에 바꿀 수 있음')}</option>
            <option value="auto">{t('복잡도에 따라 자동 선택')}</option>
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={draft.refine} onChange={(e) => change('refine', e.target.checked)} />
          {t('전송 전에 질문 다듬기와 검토')}
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.autoTitle}
            onChange={(e) => change('autoTitle', e.target.checked)}
          />
          {t('새 질문 제목 자동 생성, 질문과 이미지와 첨부 기반 (추가 모델 요청)')}
        </label>
      </section>
      <section>
        <h3>{t('개념 추출')}</h3>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.organize}
            onChange={(e) => change('organize', e.target.checked)}
          />
          {t('답변 후 개념과 관계를 자동 추출 (추가 모델 요청)')}
        </label>
        <label>
          {t('추출 대기 시간 (초)')}
          <input
            type="number"
            min={0}
            max={3600}
            value={draft.extractDelaySec}
            disabled={!draft.organize && !draft.answerHabits}
            onChange={(e) => change('extractDelaySec', Math.max(0, Math.round(Number(e.target.value) || 0)))}
          />
        </label>
      </section>
      <section>
        <h3>{t('참고 지식')}</h3>
        <label>
          {t('질문에 참고할 지식')}
          <select
            value={draft.memoryScope}
            onChange={(e) => change('memoryScope', e.target.value as LocalSettings['memoryScope'])}
          >
            <option value="off">{t('참고하지 않음')}</option>
            <option value="project">{t('현재 프로젝트')}</option>
            <option value="workspace">{t('워크스페이스 전체')}</option>
          </select>
        </label>
        <label>
          {t('참고 지식 최대 토큰')}
          <input
            type="number"
            min={100}
            max={20000}
            step={100}
            value={draft.memoryTokens}
            disabled={draft.memoryScope === 'off'}
            onChange={(e) => change('memoryTokens', Math.max(0, Math.round(Number(e.target.value) || 0)))}
          />
        </label>
      </section>
      <section>
        <h3>{t('답변 습관')}</h3>
        <label className="check">
          <input
            type="checkbox"
            checked={draft.answerHabits}
            onChange={(e) => change('answerHabits', e.target.checked)}
          />
          {t('답변 습관 사용: 형식에 대한 피드백에서 답변 방식을 배우고 다음 답변에 적용')}
        </label>
        <small>
          {t(
            '형식에 대한 피드백은 개념 추출과 같은 시점(추출 대기 시간 뒤 또는 질문을 떠날 때)에 확인하며, 새 방식은 알림에서 승인한 뒤에 적용됩니다. "앞으로", "항상"처럼 직접 요청한 방식은 바로 적용되고 알림에서 끌 수 있습니다.'
          )}
        </small>
        <HabitSection />
      </section>
    </>
  )
  const captureContent = (
    <section ref={captureSection}>
      <h3>{t('캡처 영역')}</h3>
      {captureReason && <p role="alert">{t(captureSetupMessage(captureReason))}</p>}
      <p>{t('영역 설정에서 박스 안은 선명하게, 바깥은 흐리게 표시됩니다. 저장한 영역 안쪽만 전송합니다.')}</p>
      <label>
        {t('대상 모니터')}
        <select
          ref={captureDisplay}
          value={selectedDisplayId ?? ''}
          disabled={refreshingDisplays || editing}
          onChange={(e) => {
            const displayId = e.target.value === '' ? undefined : Number(e.target.value)
            preferredDisplayId.current = displayId
            setSelectedDisplayId(displayId)
          }}
        >
          <option value="">{t('모니터를 선택해 주세요.')}</option>
          {displays.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label} ({d.width} × {d.height})
            </option>
          ))}
        </select>
      </label>
      <small>{t('모니터나 화면 크기가 바뀌면 펜 표시는 지워집니다.')}</small>
      <div className="button-row">
        <button
          disabled={busy || refreshingDisplays || editing || displayError !== '' || selectedDisplayId === undefined}
          onClick={() => void editCaptureRegion()}
        >
          <Icon name="capture" />
          {t('캡처 영역 설정')}
        </button>
        <button disabled={refreshingDisplays || editing} onClick={() => void refreshDisplays()}>
          {t('모니터 다시 검색')}
        </button>
      </div>
      {displayError && <p role="alert">{displayError}</p>}
      {!refreshingDisplays && !displayError && !displays.length && (
        <p role="status">{t('연결된 모니터가 없습니다. 모니터를 연결한 뒤 다시 검색해 주세요.')}</p>
      )}
      <small>{t('모니터와 캡처 영역은 편집 화면에서 적용을 눌러야 저장됩니다.')}</small>
      {selectedDisplayId !== undefined && (
        <small>
          {settings.regions.some((region) => region.displayId === selectedDisplayId)
            ? t('저장된 영역이 있습니다. 영역은 모니터별로 기억합니다.')
            : t('아직 영역을 정하지 않았습니다. 현재 기본값은 전체 모니터입니다.')}
        </small>
      )}
    </section>
  )
  const displayContent = (
    <>
      <p>{t('이 기기에만 적용되며 바로 바뀝니다.')}</p>
      <section>
        <h3>{t('화면 테마')}</h3>
        <label>
          {t('테마')}
          <select
            value={theme}
            onChange={(e) => {
              const v = e.target.value as ThemePref
              setThemeState(v)
              setTheme(v)
            }}
          >
            {THEME_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {t(o.label)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('글꼴 크기')}
          <select
            value={fontScale}
            onChange={(e) => {
              const v = e.target.value as FontScale
              setFontScaleState(v)
              setFontScale(v)
            }}
          >
            {FONT_SCALE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {t(o.label)}
              </option>
            ))}
          </select>
        </label>
      </section>
      <section>
        <h3>{t('언어와 알림')}</h3>
        <label>
          {t('언어')}
          <select
            value={language}
            onChange={(e) => {
              const v = e.target.value as LanguagePref
              setLanguageState(v)
              setLanguage(v)
              void window.fask.setUiLanguage(resolveLanguage(v))
            }}
          >
            {LANGUAGE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.value === 'system' ? t(o.label) : o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={answerBlink}
            onChange={(e) => {
              setAnswerBlinkState(e.target.checked)
              setAnswerBlink(e.target.checked)
            }}
          />
          {t('답변 완료 시 토글 로고 깜빡임')}
        </label>
      </section>
    </>
  )
  const devicesContent = (
    <>
      <MobileHubSection share={share} />
      <PeerSection share={share} />
    </>
  )
  const dataContent = (
    <>
      <section>
        <h3>{t('이미지 보관')}</h3>
        <label>
          {t('보관 방식')}
          <select
            value={draft.retention}
            onChange={(e) => change('retention', e.target.value as LocalSettings['retention'])}
          >
            <option value="minimal">{t('최소: 답변 완료 후 캡처 제거')}</option>
            <option value="balanced">{t('균형: 선택 영역 JPEG 보관')}</option>
            <option value="preserve">{t('보존: 선택 영역 PNG 보관')}</option>
          </select>
        </label>
        <p>
          {t(
            '실패한 질문의 이미지는 재시도를 위해 남깁니다. 기존 이미지는 질문 상세에서 직접 제거할 수 있습니다.'
          )}
        </p>
      </section>
      <section>
        <h3>{t('백업과 복원')}</h3>
        <p>
          {t(
            '현재 프로필의 질문, 개념, 이미지를 백업합니다. 복원은 새 프로필에 추가하며 접속 키는 포함하지 않습니다.'
          )}
        </p>
        <div className="button-row">
          <button disabled={busy} onClick={() => void run(() => window.fask.backup(), t('백업 창을 닫았습니다.'))}>
            {t('백업 내보내기')}
          </button>
          <button
            disabled={busy || editing}
            onClick={() =>
              void run(async () => {
                if (await window.fask.restore()) close()
              }, t('복원 창을 닫았습니다.'))
            }
          >
            {t('백업 복원')}
          </button>
        </div>
      </section>
    </>
  )
  const content: Record<SettingsCategory, React.JSX.Element> = {
    ai: aiContent,
    questions: questionsContent,
    capture: captureContent,
    display: displayContent,
    devices: devicesContent,
    data: dataContent
  }
  if (variant === 'capture')
    return (
      <div className="modal-backdrop">
        <section className="settings-modal" role="dialog" aria-modal="true" aria-label={t('화면 캡처')}>
          <header>
            <h2>{t('화면 캡처')}</h2>
            <button disabled={editing} onClick={close}>
              <Icon name="close" size={14} />
              {t('닫기')}
            </button>
          </header>
          <div className="settings-body">{captureContent}</div>
          <footer>
            <span role="status">{notice}</span>
          </footer>
        </section>
      </div>
    )
  return (
    <div className="settings-page">
      <aside className="settings-nav">
        <button className="settings-back" disabled={editing} onClick={close}>
          <Icon name="back" />
          {t('돌아가기')}
        </button>
        <h2>{t('설정')}</h2>
        <nav aria-label={t('설정 항목')}>
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              className={category === c.id ? 'active' : ''}
              aria-current={category === c.id ? 'page' : undefined}
              onClick={() => setCategory(c.id)}
            >
              <Icon name={c.icon} />
              {t(c.label)}
            </button>
          ))}
        </nav>
      </aside>
      <section className="settings-main" aria-label={shownLabel}>
        <div className="settings-scroll" ref={scrollRef}>
          <div className="settings-body">
            <h2>{shownLabel}</h2>
            {content[shown]}
          </div>
        </div>
        <footer className="settings-footer">
          <div>
            <span role="status">{notice}</span>
            <button
              className="primary"
              disabled={busy || editing}
              onClick={() =>
                void run(async () => {
                  await save()
                  close()
                }, t('저장했습니다.'))
              }
            >
              {t('설정 저장')}
            </button>
          </div>
        </footer>
      </section>
    </div>
  )
}

const STATUS_LABEL: Record<PeerStatus, string> = {
  online: '온라인',
  offline: '오프라인',
  revoked: '연결 해제됨',
  blocked: '인증서 불일치'
}

interface PeerShare {
  code: PeerCode | null
  now: number
  error: string
  busy: boolean
  begin(): Promise<void>
  cancel(): Promise<void>
}

/** One pairing code shared by the mobile and PC sections. */
function usePeerCode(): PeerShare {
  const [code, setCode] = useState<PeerCode | null>(null),
    [now, setNow] = useState(() => Date.now()),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const active = !!code
  useEffect(() => {
    const sync = (): void => {
      void window.fask
        .peerCodeStatus()
        .then((s) =>
          setCode((c) =>
            s
              ? { addresses: [], relay: false, ...c, code: s.code, expiresAt: s.expiresAt }
              : null
          )
        )
        .catch((e) => {
          // The rendezvous wait was taken over; the host already dropped the code.
          setCode(null)
          setError(errorText(e))
        })
    }
    sync()
    const off = window.fask.onChanged(sync)
    // Relay takeovers send no change event, so poll while a code is shown.
    const poll = active ? setInterval(sync, 5000) : null
    return () => {
      off()
      clearInterval(poll ?? undefined)
    }
  }, [active])
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  const act = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return {
    code,
    now,
    error,
    busy,
    begin: () =>
      act(async () => {
        const c = await window.fask.peerCodeBegin()
        setNow(Date.now())
        setCode(c)
      }),
    cancel: () =>
      act(async () => {
        await window.fask.peerCodeCancel()
        setCode(null)
      })
  }
}

function PeerCodeBox({ share }: { share: PeerShare }): React.JSX.Element {
  const { code, now, error, busy } = share
  const t = useT()
  const left = code ? Math.max(0, Math.ceil((code.expiresAt - now) / 1000)) : 0
  const urgent = left > 0 && left <= 60
  return (
    <div className="peer-code">
      {code ? (
        <div className={`peer-code-card${left === 0 ? ' expired' : urgent ? ' urgent' : ''}`}>
          <span className="peer-code-value" aria-label={t('기기 연결 코드')}>
            {code.code.slice(0, 4)}
            <i>-</i>
            {code.code.slice(4)}
          </span>
          <span className="peer-code-timer">
            {left > 0
              ? `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`
              : t('코드가 만료되었습니다')}
          </span>
          {left > 0 && code.expiresAt > now && (
            <span className="peer-code-progress">
              <span style={{ transform: `scaleX(${Math.min(1, left / 300)})` }} />
            </span>
          )}
          {(code.addresses.length > 0 || code.relay) && (
            <span className="peer-code-paths">
              {code.addresses.length > 0 && <span className="pill">Tailscale {code.addresses.join(', ')}</span>}
              {code.relay && <span className="pill">{t('릴레이')}</span>}
            </span>
          )}
          <button disabled={busy} onClick={() => void share.cancel()}>
            {t('취소')}
          </button>
        </div>
      ) : (
        <button className="peer-code-start" disabled={busy} onClick={() => void share.begin()}>
          {t('기기 연결 코드 만들기')}
        </button>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  )
}

/** Status text of a linked PC's knowledge-manager state; `none` shows nothing. */
const MANAGER_LABELS: Record<Exclude<ManagerState, 'none'>, string> = {
  pending: '관리자 요청 대기',
  granted: '지식 관리자',
  rejected: '요청 거절됨'
}

function PeerSection({ share }: { share: PeerShare }): React.JSX.Element {
  const [grants, setGrants] = useState<PeerGrantInfo[]>([]),
    [links, setLinks] = useState<PeerLinkInfo[]>([]),
    [mode, setMode] = useState<'direct' | 'relay'>('direct'),
    [address, setAddress] = useState(''),
    [code, setCode] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const t = useT()
  useEffect(() => {
    const load = (): void => {
      void window.fask
        .peerGrants()
        .then(setGrants)
        .catch(() => {})
      void window.fask
        .peerLinks()
        .then(setLinks)
        .catch(() => {})
    }
    load()
    return window.fask.onChanged(load)
  }, [])
  const act = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await fn()
      setGrants(await window.fask.peerGrants())
      setLinks(await window.fask.peerLinks())
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <section className="hub-settings">
      <h3>{t('다른 PC 연결')}</h3>
      <p>{t('이 PC의 워크스페이스를 다른 PC와 공유하려면 연결 코드를 만들어 상대 PC에 입력하세요.')}</p>
      <PeerCodeBox share={share} />
      <h4>{t('연결된 PC')}</h4>
      {grants.length ? (
        <ul className="peer-list">
          {grants.map((g) => (
            <li key={g.id}>
              <span className="peer-avatar">
                <Icon name="device" size={18} />
              </span>
              <span className="peer-info">
                <strong>{g.name}</strong>
                <small>
                  {new Date(g.createdAt).toLocaleString()}
                  {g.manager !== 'none' && ` · ${t(MANAGER_LABELS[g.manager])}`}
                </small>
              </span>
              {g.manager === 'pending' ? (
                <>
                  <button
                    disabled={busy}
                    onClick={() => void act(() => window.fask.peerGrantManager(g.id, 'grant'))}
                  >
                    {t('수락')}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => void act(() => window.fask.peerGrantManager(g.id, 'reject'))}
                  >
                    {t('거절')}
                  </button>
                </>
              ) : g.manager === 'granted' ? (
                <button
                  disabled={busy}
                  onClick={() => void act(() => window.fask.peerGrantManager(g.id, 'revoke'))}
                >
                  {t('관리자 해제')}
                </button>
              ) : (
                <button
                  disabled={busy}
                  onClick={() => void act(() => window.fask.peerGrantManager(g.id, 'grant'))}
                >
                  {t('관리자로 지정')}
                </button>
              )}
              <button
                className="danger"
                disabled={busy}
                onClick={() => void act(() => window.fask.peerGrantRevoke(g.id))}
              >
                {t('해제')}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <small className="peer-empty">{t('연결된 PC가 없습니다.')}</small>
      )}
      <h4>{t('다른 PC에 연결')}</h4>
      <div className="segmented" role="radiogroup" aria-label={t('연결 경로')}>
        <label className={mode === 'direct' ? 'on' : ''}>
          <input type="radio" checked={mode === 'direct'} onChange={() => setMode('direct')} />
          {t('Tailscale 주소')}
        </label>
        <label className={mode === 'relay' ? 'on' : ''}>
          <input type="radio" checked={mode === 'relay'} onChange={() => setMode('relay')} />
          {t('릴레이')}
        </label>
      </div>
      <div className="peer-connect">
        {mode === 'direct' && (
          <input
            aria-label={t('Tailscale 주소')}
            placeholder={t('100.x.y.z 또는 이름.ts.net')}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        )}
        <input
          className="peer-code-input"
          aria-label={t('연결 코드')}
          placeholder="XXXX-XXXX"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <button
          disabled={busy || !code.trim() || (mode === 'direct' && !address.trim())}
          onClick={() =>
            void act(async () => {
              await window.fask.peerPair(
                mode === 'direct' ? { kind: 'direct', address: address.trim() } : { kind: 'relay' },
                code
              )
              setCode('')
            })
          }
        >
          {busy ? t('연결 중…') : t('연결')}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {links.length > 0 && (
        <ul className="peer-list">
          {links.map((l) => (
            <li key={l.id}>
              <span className="peer-avatar">
                <Icon name="globe" size={18} />
              </span>
              <span className="peer-info">
                <strong>{l.name}</strong>
                <small>{l.paths.map((p) => (p === 'tailscale' ? 'Tailscale' : t('릴레이'))).join(', ')}</small>
              </span>
              <span className={`status-pill ${l.status}`}>{t(STATUS_LABEL[l.status])}</span>
              <button disabled={busy} onClick={() => void act(() => window.fask.peerUnlink(l.id))}>
                {t('연결 해제')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Applies immediately, independent of "설정 저장". */
function MobileHubSection({ share }: { share: PeerShare }): React.JSX.Element {
  const [status, setStatus] = useState<HubStatus | null>(null),
    [qr, setQr] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [relayUrl, setRelayUrl] = useState('')
  const t = useT()
  const apply = async (fn: () => Promise<HubStatus>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      setStatus(await fn())
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    void window.fask
      .hubStatus()
      .then(setStatus)
      .catch((e) => setError(errorText(e)))
  }, [])
  const relayPolling = !!status?.enabled && !!status.relay.enabled
  useEffect(() => {
    if (!relayPolling) return
    const timer = setInterval(() => {
      void window.fask
        .hubStatus()
        .then(setStatus)
        .catch(() => {})
    }, 3000)
    return () => clearInterval(timer)
  }, [relayPolling])
  const savedRelayUrl = status?.relay.url ?? ''
  useEffect(() => setRelayUrl(savedRelayUrl), [savedRelayUrl])
  const pairing = status?.pairing ?? ''
  useEffect(() => {
    let alive = true
    if (pairing)
      void QRCode.toDataURL(pairing, { margin: 1, width: 240 }).then((url) => {
        if (alive) setQr(url)
      })
    return () => {
      alive = false
    }
  }, [pairing])
  return (
    <section className="hub-settings">
      <h3>{t('모바일 연결')}</h3>
      <label className="check">
        <input
          type="checkbox"
          checked={!!status?.enabled}
          disabled={busy || !status}
          onChange={(e) => {
            const enabled = e.target.checked
            void apply(() => window.fask.setHub(enabled))
          }}
        />
        {t('모바일 연결 허용')}
      </label>
      {status?.enabled && (
        <>
          {status.addresses.map((a) => (
            <label className="check" key={a.address}>
              <input
                type="checkbox"
                checked={a.selected}
                disabled={busy}
                onChange={(e) => {
                  const next = status.addresses
                    .filter((x) => (x.address === a.address ? e.target.checked : x.selected))
                    .map((x) => x.address)
                  void apply(() => window.fask.setHubAddresses(next))
                }}
              />
              <span>{a.address}</span>
              <span className="check-meta">
                {a.kind === 'tailscale'
                  ? t('Tailscale, 외부에서도 연결')
                  : a.kind === 'lan'
                    ? t('같은 Wi‑Fi')
                    : t('기타 네트워크')}
              </span>
              <span className="check-meta">{a.recommended ? t('권장') : t('권장하지 않음')}</span>
              {a.error && <small className="error"> {t(a.error)}</small>}
            </label>
          ))}
          <label className="check">
            <input
              type="checkbox"
              checked={status.relay.enabled}
              disabled={busy}
              onChange={(e) => {
                const enabled = e.target.checked
                void apply(() => window.fask.setHubRelay(enabled, relayUrl))
              }}
            />
            {t('중계 서버로 외부 연결 (Tailscale 없이)')}
          </label>
          <input
            type="url"
            value={relayUrl}
            placeholder="wss://…"
            aria-label={t('중계 서버 주소')}
            disabled={busy}
            onChange={(e) => setRelayUrl(e.target.value)}
            onBlur={() => {
              if (relayUrl.trim() !== savedRelayUrl)
                void apply(() => window.fask.setHubRelay(status.relay.enabled, relayUrl))
            }}
          />
          {status.relay.state === 'online' && <p>{t('중계 서버 연결됨')}</p>}
          {status.relay.state === 'connecting' && <p>{t('중계 서버에 연결 중…')}</p>}
          {status.relay.state === 'error' && <p className="error">{t(status.relay.error ?? '')}</p>}
          {status.error && <p className="error">{t(status.error)}</p>}
          {pairing && qr && <img className="hub-qr" src={qr} alt={t('모바일 연결 QR 코드')} />}
          <PeerCodeBox share={share} />
          <button disabled={busy} onClick={() => void apply(() => window.fask.resetHubPairing())}>
            {t('연결 초기화하고 모든 기기 해제')}
          </button>
        </>
      )}
      {error && <p className="error">{error}</p>}
      <p>
        {t(
          'QR에는 연결 키가 들어 있습니다. 다른 사람에게 보여 주지 마세요. 통신은 TLS로 암호화됩니다. Tailscale 주소나 중계 서버를 쓰면 집 밖에서도 연결할 수 있고, 중계 서버는 암호화된 데이터만 전달합니다. Windows 방화벽 창이 뜨면 허용하세요.'
        )}
      </p>
    </section>
  )
}

const HABIT_GROUPS: { status: Habit['status']; title: string }[] = [
  { status: 'proposed', title: '제안' },
  { status: 'active', title: '사용 중' },
  { status: 'rejected', title: '꺼짐' }
]

function HabitSection(): React.JSX.Element {
  const [list, setList] = useState<HabitList | null>(null),
    [editing, setEditing] = useState<HabitInput | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [dragging, setDragging] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const t = useT()
  useEffect(() => {
    const load = (): void => {
      void window.fask
        .habits()
        .then(setList)
        .catch((e) => setError(errorText(e)))
    }
    load()
    return window.fask.onChanged(load)
  }, [])
  const act = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await fn()
      setList(await window.fask.habits())
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const importFile = (file: File | undefined): void => {
    if (!file) return
    if (file.size > 1_000_000) {
      setNotice('')
      setError(t('습관 파일이 너무 큽니다.'))
      return
    }
    void act(async () => {
      const r = await window.fask.importHabits(await file.text())
      setNotice(
        t('습관 {{added}}개를 불러왔습니다. {{skipped}}개는 이미 있거나 맞는 워크스페이스가 없어 건너뛰었습니다.', r)
      )
    })
  }
  const habits = list?.habits ?? []
  const workspaces = list?.workspaces ?? []
  return (
    <>
      {editing && (
        <div>
          <label>
            {t('습관')}
            <input
              value={editing.rule}
              maxLength={300}
              onChange={(e) => setEditing({ ...editing, rule: e.target.value })}
            />
          </label>
          <label>
            {t('상황')}
            <input
              value={editing.when}
              maxLength={200}
              placeholder={t('상황 키워드를 쉼표로 구분 (예: 수식, 공식, LaTeX). 비우면 모든 답변')}
              onChange={(e) => setEditing({ ...editing, when: e.target.value })}
            />
          </label>
          <label>
            {t('범위')}
            <select
              value={editing.scope === 'workspace' ? `ws:${editing.workspaceId}` : 'profile'}
              onChange={(e) => {
                const v = e.target.value
                setEditing(
                  v.startsWith('ws:')
                    ? { ...editing, scope: 'workspace', workspaceId: v.slice(3) }
                    : { ...editing, scope: 'profile', workspaceId: null }
                )
              }}
            >
              <option value="profile">{t('모든 워크스페이스')}</option>
              {workspaces.map((w) => (
                <option key={w.id} value={`ws:${w.id}`}>
                  {w.name}
                </option>
              ))}
            </select>
          </label>
          <button
            disabled={busy || !editing.rule.trim()}
            onClick={() =>
              void act(async () => {
                await window.fask.saveHabit(editing)
                setEditing(null)
              })
            }
          >
            {t('저장')}
          </button>
          <button disabled={busy} onClick={() => setEditing(null)}>
            {t('취소')}
          </button>
        </div>
      )}
      {list && !habits.length && <p className="peer-empty">{t('아직 기억한 답변 습관이 없습니다.')}</p>}
      {HABIT_GROUPS.map(({ status, title }) => {
        const group = habits.filter((h) => h.status === status)
        if (!group.length) return null
        return (
          <div key={status}>
            <h4>{t(title)}</h4>
            <ul className="peer-list">
              {group.map((h) => (
                <li key={h.id}>
                  <span className="peer-info">
                    <strong>{h.rule}</strong>
                    <small>
                      {h.when || t('모든 답변')} ·{' '}
                      {h.scope === 'workspace'
                        ? (workspaces.find((w) => w.id === h.workspaceId)?.name ?? '')
                        : t('모든 워크스페이스')}{' '}
                      · {t('{{n}}번 요청', { n: h.count })}
                    </small>
                  </span>
                  {status === 'proposed' && (
                    <>
                      <button disabled={busy} onClick={() => void act(() => window.fask.decideHabit(h.id, 'active'))}>
                        {t('기억')}
                      </button>
                      <button disabled={busy} onClick={() => void act(() => window.fask.decideHabit(h.id, 'rejected'))}>
                        {t('무시')}
                      </button>
                    </>
                  )}
                  {status === 'active' && (
                    <>
                      <button disabled={busy} onClick={() => void act(() => window.fask.decideHabit(h.id, 'rejected'))}>
                        {t('끄기')}
                      </button>
                      <button
                        disabled={busy}
                        onClick={() =>
                          setEditing({ id: h.id, rule: h.rule, when: h.when, scope: h.scope, workspaceId: h.workspaceId })
                        }
                      >
                        {t('편집')}
                      </button>
                    </>
                  )}
                  {status === 'rejected' && (
                    <button disabled={busy} onClick={() => void act(() => window.fask.decideHabit(h.id, 'active'))}>
                      {t('켜기')}
                    </button>
                  )}
                  {status !== 'proposed' && (
                    <button
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(t('이 습관을 삭제할까요?'))) void act(() => window.fask.removeHabit(h.id))
                      }}
                    >
                      {t('삭제')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )
      })}
      <div>
        <button
          disabled={busy || !list}
          onClick={() => setEditing({ rule: '', when: '', scope: 'profile', workspaceId: null })}
        >
          {t('습관 추가')}
        </button>
        <button
          disabled={busy || !habits.some((h) => h.status === 'active')}
          onClick={() =>
            void act(async () => {
              await window.fask.exportHabits()
            })
          }
        >
          {t('파일로 저장')}
        </button>
      </div>
      <div
        className={`habit-drop${dragging ? ' dragging' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => fileInput.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') fileInput.current?.click()
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          importFile(e.dataTransfer.files[0])
        }}
      >
        {t('다른 프로필이나 PC에서 저장한 습관 파일(.json)을 여기로 끌어 놓거나 눌러서 고르세요.')}
        <input
          ref={fileInput}
          type="file"
          accept=".json,application/json"
          hidden
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            importFile(e.target.files?.[0])
            e.target.value = ''
          }}
        />
      </div>
      {notice && <p>{notice}</p>}
      {error && <p className="error">{error}</p>}
    </>
  )
}
