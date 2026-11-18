import { useCallback, useEffect, useState, type ReactNode } from 'react'
import type { LockState } from '../../../preload/personal'
import { useT } from '../../../shared/i18n/react'
import ProfileAvatar from './ProfileAvatar'
import { Icon } from './ToolbarIcons'
import { errorText } from './common'

/** Shows the lock screen instead of its children while the profile is locked; children stay unmounted. */
export function LockGate({ children }: { children: ReactNode }): React.JSX.Element | null {
  const [state, setState] = useState<LockState | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => {
    window.fask
      .lockState()
      .then((s) => {
        setState(s)
        setError('')
      })
      .catch((e: unknown) => setError(errorText(e)))
  }, [])
  useEffect(() => {
    load()
    return window.fask.onChanged(load)
  }, [load])
  if (!state) return error ? <div className="fask-loading">{error}</div> : null
  return state.locked ? <LockScreen state={state} onChange={load} /> : <>{children}</>
}

function LockScreen({ state, onChange }: { state: LockState; onChange: () => void }): React.JSX.Element {
  const t = useT()
  const [pin, setPin] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [now, setNow] = useState(() => Date.now()),
    [resetting, setResetting] = useState(false),
    [confirm, setConfirm] = useState('')
  const waiting = state.retryAt !== null && state.retryAt > now
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [waiting])
  const act = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await fn()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
      setNow(Date.now())
      onChange()
    }
  }
  return (
    <div className="fask-app lock-screen">
      <form
        className="lock-card"
        onSubmit={(e) => {
          e.preventDefault()
          void act(async () => {
            await window.fask.unlock(pin)
            setPin('')
          })
        }}
      >
        <ProfileAvatar avatar={state.profile.avatar} name={state.profile.name} size={64} />
        <h1>{state.profile.name}</h1>
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          maxLength={12}
          autoFocus
          aria-label={t('PIN')}
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
        />
        <button className="primary" disabled={busy || waiting || !pin}>
          <Icon name="lock" />
          {t('잠금 해제')}
        </button>
        {waiting && (
          <p className="lock-wait" role="status">
            {t('{{sec}}초 후에 다시 시도해 주세요.', { sec: Math.ceil((state.retryAt! - now) / 1000) })}
          </p>
        )}
        {error && !waiting && <p className="error">{error}</p>}
        {resetting ? (
          <div className="lock-reset">
            <p>{t('PIN과 모델·Jev 키를 지우고 잠금을 풉니다. 질문 기록은 남습니다.')}</p>
            <label>
              {t('확인하려면 "{{word}}"라고 입력하세요.', { word: t('초기화') })}
              <input autoComplete="off" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </label>
            <div className="button-row">
              <button
                type="button"
                onClick={() => {
                  setResetting(false)
                  setConfirm('')
                }}
              >
                {t('취소')}
              </button>
              <button
                type="button"
                className="danger"
                disabled={busy || confirm !== t('초기화')}
                onClick={() => void act(() => window.fask.resetPin())}
              >
                {t('PIN과 저장된 키 삭제')}
              </button>
            </div>
          </div>
        ) : (
          <button type="button" className="lock-forgot" onClick={() => setResetting(true)}>
            {t('PIN을 잊었나요?')}
          </button>
        )}
      </form>
    </div>
  )
}
