import { useEffect, useState } from 'react'
import type { DisplayInfo, LocalSettings } from '../../../preload/personal'
import { errorText } from './common'

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
