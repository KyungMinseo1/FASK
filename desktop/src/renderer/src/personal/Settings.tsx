import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import type {
  DisplayInfo,
  HubStatus,
  LocalSettings,
  PeerCode,
  PeerGrantInfo,
  PeerLinkInfo,
  PeerStatus
} from '../../../preload/personal'
import { errorText } from './common'
import { readTheme, setTheme, type ThemePref } from './theme'

export default function Settings({
  settings,
  onClose
}: {
  settings: LocalSettings
  onClose: () => void
}): React.JSX.Element {
  const [draft, setDraft] = useState(settings),
    [key, setKey] = useState<string | undefined>(),
    [displays, setDisplays] = useState<DisplayInfo[]>([])
  const [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false)
  const [theme, setThemeState] = useState(readTheme)
  const share = usePeerCode()
  useEffect(() => {
    void window.fask
      .displays()
      .then(setDisplays)
      .catch((e) => setNotice(errorText(e)))
  }, [])
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
  return (
    <div className="modal-backdrop">
      <section className="settings-modal" role="dialog" aria-modal="true" aria-label="설정">
        <header>
          <div>
            <span className="eyebrow">PREFERENCES</span>
            <h2>나에게 맞는 질문 환경</h2>
          </div>
          <button onClick={onClose}>닫기 ×</button>
        </header>
        <div className="settings-body">
          <section>
            <h3>로컬 AI 연결</h3>
            <p>EasyCLIProxyAPI에서 계정을 연결하고, Home의 OpenAI 호환 endpoint를 붙여넣으세요.</p>
            <label>
              Local API endpoint
              <input
                value={draft.endpoint}
                onChange={(e) => change('endpoint', e.target.value)}
                placeholder="http://127.0.0.1:8317/v1"
              />
            </label>
            <label>
              로컬 접속 키
              <input
                type="password"
                value={key ?? ''}
                onChange={(e) => setKey(e.target.value)}
                placeholder={
                  settings.hasKey
                    ? '저장된 키 사용 · 바꾸려면 입력'
                    : '프록시가 요구하는 경우에만 입력'
                }
              />
            </label>
            {settings.hasKey && <button onClick={() => setKey('')}>저장된 키 제거</button>}
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const models = await window.fask.models(draft.endpoint, key)
                  setDraft((s) => ({ ...s, models, model: s.model || models[0] || '' }))
                  if (!models.length)
                    throw new Error('연결됐지만 모델이 없습니다. 프록시에서 계정을 연결해 주세요.')
                }, '연결 확인 완료 · 모델 목록을 갱신했습니다. 저장을 눌러 적용하세요.')
              }
            >
              {busy ? '확인 중…' : '연결 확인 · 모델 불러오기'}
            </button>
            <datalist id="local-models">
              {draft.models.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            <div className="settings-grid">
              <label>
                기본 모델
                <input
                  list="local-models"
                  value={draft.model}
                  onChange={(e) => change('model', e.target.value)}
                />
              </label>
              <label>
                빠른 모델
                <input
                  list="local-models"
                  value={draft.fastModel}
                  onChange={(e) => change('fastModel', e.target.value)}
                  placeholder="기본 모델 사용"
                />
              </label>
              <label>
                깊은 추론 모델
                <input
                  list="local-models"
                  value={draft.deepModel}
                  onChange={(e) => change('deepModel', e.target.value)}
                  placeholder="기본 모델 사용"
                />
              </label>
            </div>
            <small>
              접속 키는 OS 저장소로 암호화합니다. 공급자 로그인과 계정·폴백 설정은
              EasyCLIProxyAPI에서 관리하세요.
            </small>
          </section>
          <section>
            <h3>질문과 기억</h3>
            <label>
              모델 선택
              <select
                value={draft.routing}
                onChange={(e) => change('routing', e.target.value as LocalSettings['routing'])}
              >
                <option value="manual">직접 선택</option>
                <option value="recommend">추천 표시 · 전송 전 변경 가능</option>
                <option value="auto">복잡도에 따라 자동 선택</option>
              </select>
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.refine}
                onChange={(e) => change('refine', e.target.checked)}
              />
              전송 전에 질문 다듬기와 검토
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.organize}
                onChange={(e) => change('organize', e.target.checked)}
              />
              답변 후 기존 개념 연결 · 새 개념 제안 (추가 모델 요청)
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.autoTitle}
                onChange={(e) => change('autoTitle', e.target.checked)}
              />
              새 질문 제목 자동 생성 · 질문·이미지·첨부 기반 (추가 모델 요청)
            </label>
            <label className="check">
              <input
                type="checkbox"
                checked={draft.memory}
                onChange={(e) => change('memory', e.target.checked)}
              />
              중요 표시한 프로젝트 기록을 다음 질문에 참고
            </label>
          </section>
          <section>
            <h3>캡처 영역</h3>
            <p>
              영역 설정에서 박스 안은 선명하게, 바깥은 흐리게 표시됩니다. 저장한 영역 안쪽만
              전송합니다.
            </p>
            <label>
              대상 모니터
              <select
                value={draft.displayId ?? displays[0]?.id ?? ''}
                onChange={(e) => change('displayId', Number(e.target.value))}
              >
                {displays.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label} · {d.width} × {d.height}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={busy || !displays.length}
              onClick={() =>
                void run(async () => {
                  await save()
                  await window.fask.openCaptureEditor(draft.displayId ?? displays[0].id)
                  onClose()
                }, '')
              }
            >
              ▧ 캡처 영역 설정
            </button>
            <small>
              {settings.regions.length
                ? '저장된 영역이 있습니다. 영역은 모니터별로 기억합니다.'
                : '아직 영역을 정하지 않았습니다. 현재 기본값은 전체 모니터입니다.'}
            </small>
          </section>
          <section>
            <h3>이미지 보관</h3>
            <label>
              보관 방식
              <select
                value={draft.retention}
                onChange={(e) => change('retention', e.target.value as LocalSettings['retention'])}
              >
                <option value="minimal">최소 · 답변 완료 후 캡처 제거</option>
                <option value="balanced">균형 · 선택 영역 JPEG 보관</option>
                <option value="preserve">보존 · 선택 영역 PNG 보관</option>
              </select>
            </label>
            <p>
              실패한 질문의 이미지는 재시도를 위해 남깁니다. 기존 이미지는 질문 상세에서 직접 제거할
              수 있습니다.
            </p>
          </section>
          <section>
            <h3>화면 테마</h3>
            <label>
              테마
              <select
                value={theme}
                onChange={(e) => {
                  const v = e.target.value as ThemePref
                  setThemeState(v)
                  setTheme(v)
                }}
              >
                <option value="system">시스템 설정 따르기</option>
                <option value="light">라이트</option>
                <option value="dark">다크</option>
              </select>
            </label>
            <small>이 기기에만 적용되며 바로 바뀝니다.</small>
          </section>
          <MobileHubSection share={share} />
          <PeerSection share={share} />
          <section>
            <h3>백업과 복원</h3>
            <p>
              현재 프로필의 질문·개념·이미지를 백업합니다. 복원은 새 프로필에 추가하며 접속 키는
              포함하지 않습니다.
            </p>
            <div className="button-row">
              <button
                disabled={busy}
                onClick={() => void run(() => window.fask.backup(), '백업 창을 닫았습니다.')}
              >
                백업 내보내기
              </button>
              <button
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (await window.fask.restore()) onClose()
                  }, '복원 창을 닫았습니다.')
                }
              >
                백업 복원
              </button>
            </div>
          </section>
        </div>
        <footer>
          <span role="status">{notice}</span>
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await save()
                onClose()
              }, '저장했습니다.')
            }
          >
            설정 저장
          </button>
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
  const left = code ? Math.max(0, Math.ceil((code.expiresAt - now) / 1000)) : 0
  const urgent = left > 0 && left <= 60
  return (
    <div className="peer-code">
      {code ? (
        <div className={`peer-code-card${left === 0 ? ' expired' : urgent ? ' urgent' : ''}`}>
          <span className="peer-code-value" aria-label="기기 연결 코드">
            {code.code.slice(0, 4)}
            <i>-</i>
            {code.code.slice(4)}
          </span>
          <span className="peer-code-timer">
            {left > 0
              ? `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`
              : '코드가 만료되었습니다'}
          </span>
          {left > 0 && code.expiresAt > now && (
            <span className="peer-code-progress">
              <span style={{ width: `${Math.min(100, (left / 300) * 100)}%` }} />
            </span>
          )}
          {(code.addresses.length > 0 || code.relay) && (
            <span className="peer-code-paths">
              {code.addresses.length > 0 && <span className="pill">Tailscale {code.addresses.join(', ')}</span>}
              {code.relay && <span className="pill">릴레이</span>}
            </span>
          )}
          <button disabled={busy} onClick={() => void share.cancel()}>
            취소
          </button>
        </div>
      ) : (
        <button className="primary peer-code-start" disabled={busy} onClick={() => void share.begin()}>
          기기 연결 코드 만들기
        </button>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  )
}

function PeerSection({ share }: { share: PeerShare }): React.JSX.Element {
  const [grants, setGrants] = useState<PeerGrantInfo[]>([]),
    [links, setLinks] = useState<PeerLinkInfo[]>([]),
    [mode, setMode] = useState<'direct' | 'relay'>('direct'),
    [address, setAddress] = useState(''),
    [code, setCode] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
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
      <h3>다른 PC 연결</h3>
      <p>이 PC의 워크스페이스를 다른 PC와 공유하려면 연결 코드를 만들어 상대 PC에 입력하세요.</p>
      <PeerCodeBox share={share} />
      <h4>연결된 PC</h4>
      {grants.length ? (
        <ul className="peer-list">
          {grants.map((g) => (
            <li key={g.id}>
              <span className="peer-avatar">💻</span>
              <span className="peer-info">
                <strong>{g.name}</strong>
                <small>{new Date(g.createdAt).toLocaleString()}</small>
              </span>
              <button
                className="danger"
                disabled={busy}
                onClick={() => void act(() => window.fask.peerGrantRevoke(g.id))}
              >
                해제
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <small className="peer-empty">연결된 PC가 없습니다.</small>
      )}
      <h4>다른 PC에 연결</h4>
      <div className="segmented" role="radiogroup" aria-label="연결 경로">
        <label className={mode === 'direct' ? 'on' : ''}>
          <input type="radio" checked={mode === 'direct'} onChange={() => setMode('direct')} />
          Tailscale 주소
        </label>
        <label className={mode === 'relay' ? 'on' : ''}>
          <input type="radio" checked={mode === 'relay'} onChange={() => setMode('relay')} />
          릴레이
        </label>
      </div>
      <div className="peer-connect">
        {mode === 'direct' && (
          <input
            aria-label="Tailscale 주소"
            placeholder="100.x.y.z 또는 이름.ts.net"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        )}
        <input
          className="peer-code-input"
          aria-label="연결 코드"
          placeholder="XXXX-XXXX"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
        <button
          className="primary"
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
          {busy ? '연결 중…' : '연결'}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {links.length > 0 && (
        <ul className="peer-list">
          {links.map((l) => (
            <li key={l.id}>
              <span className="peer-avatar">🌐</span>
              <span className="peer-info">
                <strong>{l.name}</strong>
                <small>{l.paths.map((p) => (p === 'tailscale' ? 'Tailscale' : '릴레이')).join(' · ')}</small>
              </span>
              <span className={`status-pill ${l.status}`}>{STATUS_LABEL[l.status]}</span>
              <button disabled={busy} onClick={() => void act(() => window.fask.peerUnlink(l.id))}>
                연결 해제
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
      <h3>모바일 연결</h3>
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
        모바일 연결 허용
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
              {a.address} ·{' '}
              {a.kind === 'tailscale'
                ? 'Tailscale · 외부에서도 연결'
                : a.kind === 'lan'
                  ? '같은 Wi‑Fi'
                  : '기타 네트워크'}{' '}
              {a.recommended ? '권장' : '권장하지 않음'}
              {a.error && <small className="error"> {a.error}</small>}
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
            중계 서버로 외부 연결 · Tailscale 없이
          </label>
          <input
            type="url"
            value={relayUrl}
            placeholder="wss://…"
            aria-label="중계 서버 주소"
            disabled={busy}
            onChange={(e) => setRelayUrl(e.target.value)}
            onBlur={() => {
              if (relayUrl.trim() !== savedRelayUrl)
                void apply(() => window.fask.setHubRelay(status.relay.enabled, relayUrl))
            }}
          />
          {status.relay.state === 'online' && <p>중계 서버 연결됨</p>}
          {status.relay.state === 'connecting' && <p>중계 서버에 연결 중…</p>}
          {status.relay.state === 'error' && <p className="error">{status.relay.error}</p>}
          {status.error && <p className="error">{status.error}</p>}
          {pairing && qr && <img className="hub-qr" src={qr} alt="모바일 연결 QR 코드" />}
          <PeerCodeBox share={share} />
          <button disabled={busy} onClick={() => void apply(() => window.fask.resetHubPairing())}>
            연결 초기화 · 모든 기기 해제
          </button>
        </>
      )}
      {error && <p className="error">{error}</p>}
      <p>
        QR에는 연결 키가 들어 있습니다. 다른 사람에게 보여 주지 마세요. 통신은 TLS로 암호화됩니다.
        Tailscale 주소나 중계 서버를 쓰면 집 밖에서도 연결할 수 있고, 중계 서버는 암호화된 데이터만
        전달합니다. Windows 방화벽 창이 뜨면 허용하세요.
      </p>
    </section>
  )
}
