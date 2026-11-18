import { useEffect, useState } from 'react'
import type { LockState, ProfileMergeInfo, Snapshot } from '../../../preload/personal'
import { AVATAR_COLORS, AVATAR_PALETTES, AVATAR_STYLES, type AvatarColor, type AvatarSpec, type AvatarStyle } from '../../../shared/avatar'
import { useT } from '../../../shared/i18n/react'
import ProfileAvatar from './ProfileAvatar'
import UsageHeatmap from './UsageHeatmap'
import { Icon, type IconName } from './ToolbarIcons'
import { errorText } from './common'

type Category = 'basic' | 'security'
type Section = 'profile' | 'lock' | 'merge'

const CATEGORIES: { id: Category; label: string; icon: IconName }[] = [
  { id: 'basic', label: '기본 설정', icon: 'user' },
  { id: 'security', label: '보안', icon: 'lock' }
]
const STYLE_LABELS: Record<AvatarStyle, string> = {
  monogram: '이니셜',
  bauhaus: '바우하우스',
  eclipse: '일식',
  orbit: '궤도',
  dots: '점',
  waves: '물결'
}
/** Palettes are named after the themes they come from (the same labels as the theme setting). */
const COLOR_LABELS: Record<AvatarColor, string> = {
  navy: '네이비',
  white: '화이트',
  ivory: '아이보리',
  lavender: '라벤더',
  night: '제트 블랙'
}

/** Full-page profile screen in the settings frame: basic settings (picture, name, usage) and security (PIN). */
export default function ProfilePage({
  data,
  onClose,
  onOpenDevices
}: {
  data: Snapshot
  onClose: () => void
  onOpenDevices: () => void
}): React.JSX.Element {
  const t = useT()
  const [category, setCategory] = useState<Category>('basic'),
    [name, setName] = useState(data.profile.name),
    [avatar, setAvatar] = useState<AvatarSpec>(data.profile.avatar),
    [lock, setLock] = useState<LockState | null>(null),
    [merge, setMerge] = useState<ProfileMergeInfo | null>(null),
    [pins, setPins] = useState({ current: '', next: '', confirm: '' }),
    [pinMode, setPinMode] = useState<'change' | 'remove' | null>(null),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState<{ section: Section; text: string; error: boolean } | null>(null)
  useEffect(() => {
    const load = (): void => {
      void window.fask
        .lockState()
        .then(setLock)
        .catch(() => {})
      void window.fask
        .profileMergeInfo()
        .then(setMerge)
        .catch(() => {})
    }
    load()
    return window.fask.onChanged(load)
  }, [])
  const act = async (section: Section, fn: () => Promise<void>, done: string): Promise<void> => {
    setBusy(true)
    setStatus(null)
    try {
      await fn()
      setStatus({ section, text: done, error: false })
    } catch (e) {
      setStatus({ section, text: errorText(e), error: true })
    } finally {
      setBusy(false)
    }
  }
  const pinField = (field: keyof typeof pins, label: string): React.JSX.Element => (
    <label>
      {t(label)}
      <input
        type="password"
        inputMode="numeric"
        autoComplete="off"
        maxLength={12}
        value={pins[field]}
        onChange={(e) => setPins((p) => ({ ...p, [field]: e.target.value.replace(/\D/g, '') }))}
      />
    </label>
  )
  const statusOf = (section: Section): React.JSX.Element | null =>
    status?.section === section && status.text ? (
      <p className={status.error ? 'error' : undefined} role="status">
        {status.text}
      </p>
    ) : null
  const mismatch = pins.next !== pins.confirm
  const trimmed = name.trim()
  const shownName = trimmed || data.profile.name
  const changed =
    trimmed !== data.profile.name ||
    avatar.style !== data.profile.avatar.style ||
    avatar.seed !== data.profile.avatar.seed ||
    avatar.background !== data.profile.avatar.background
  const label = t(CATEGORIES.find((c) => c.id === category)!.label)

  const basic = (
    <>
      <section>
        <h3>{t('프로필')}</h3>
        <div className="profile-hero">
          <ProfileAvatar avatar={avatar} name={shownName} size={88} />
          <div>
            <b>{shownName}</b>
            <small>{t('이 PC: {{device}}', { device: data.device })}</small>
          </div>
        </div>
        <label>
          {t('이름')}
          <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} />
        </label>
        <h4>{t('모양')}</h4>
        <div className="profile-styles" role="radiogroup" aria-label={t('모양')}>
          {AVATAR_STYLES.map((style) => (
            <button
              key={style}
              type="button"
              role="radio"
              aria-checked={avatar.style === style}
              className={avatar.style === style ? 'active' : ''}
              onClick={() => setAvatar((a) => ({ ...a, style }))}
            >
              <ProfileAvatar avatar={{ ...avatar, style }} name={shownName} size={44} />
              <span>{t(STYLE_LABELS[style])}</span>
            </button>
          ))}
        </div>
        <h4>{t('색상')}</h4>
        <div className="profile-colors" role="radiogroup" aria-label={t('색상')}>
          {AVATAR_COLORS.map((color) => {
            const p = AVATAR_PALETTES[color]
            return (
              <button
                key={color}
                type="button"
                role="radio"
                aria-checked={avatar.background === color}
                className={avatar.background === color ? 'active' : ''}
                onClick={() => setAvatar((a) => ({ ...a, background: color }))}
              >
                <span className="profile-swatch" style={{ background: p.bg }}>
                  <i style={{ background: p.fg }} />
                  <i style={{ background: p.accent }} />
                </span>
                {t(COLOR_LABELS[color])}
              </button>
            )
          })}
        </div>
        <div className="button-row">
          <button type="button" onClick={() => setAvatar((a) => ({ ...a, seed: crypto.randomUUID() }))}>
            {t('다시 뽑기')}
          </button>
          <button
            className="primary"
            disabled={busy || !trimmed || !changed}
            onClick={() =>
              void act('profile', () => window.fask.profileUpdate({ name: trimmed, avatar }), t('저장했습니다.'))
            }
          >
            {t('저장')}
          </button>
        </div>
        {statusOf('profile')}
      </section>
      <section>
        <h3>{t('사용량')}</h3>
        <UsageHeatmap />
      </section>
      {merge && (
        <section>
          <h3>{t('프로필 합치기')}</h3>
          <p>
            {t(
              '이번 버전부터 PC마다 프로필이 하나입니다. 다른 프로필({{names}})의 워크스페이스 {{workspaces}}개와 질문 {{questions}}개를 지금 프로필로 합칠 수 있습니다. 합치면 그 프로필의 설정과 API 키는 삭제되고, 합치기 전 데이터는 자동으로 백업됩니다.',
              {
                names: merge.others.map((o) => o.name).join(', '),
                workspaces: merge.others.reduce((n, o) => n + o.workspaces, 0),
                questions: merge.others.reduce((n, o) => n + o.questions, 0)
              }
            )}
          </p>
          <button disabled={busy} onClick={() => void act('merge', () => window.fask.profileMerge(), t('합쳤습니다.'))}>
            {t('합치기')}
          </button>
          {statusOf('merge')}
        </section>
      )}
      <section>
        <h3>{t('기기 연결')}</h3>
        <button onClick={onOpenDevices}>
          <Icon name="devices" />
          {t('기기 연결 관리')}
        </button>
      </section>
    </>
  )

  const security = (
    <section>
      <h3>{t('PIN 잠금')}</h3>
      <p>
        {t(
          'PIN은 이 PC의 앱 화면과 모델·Jev 키를 잠급니다. 질문 기록 파일은 암호화되지 않으며, 연결된 기기는 잠긴 동안에도 공유된 기록을 볼 수 있습니다.'
        )}
      </p>
      {lock && !lock.hasPin && (
        <>
          {pinField('next', '새 PIN')}
          {pinField('confirm', 'PIN 확인')}
          <button
            disabled={busy || !pins.next || mismatch}
            onClick={() =>
              void act(
                'lock',
                async () => {
                  await window.fask.setPin(undefined, pins.next)
                  setPins({ current: '', next: '', confirm: '' })
                },
                t('PIN을 설정했습니다.')
              )
            }
          >
            {t('PIN 설정')}
          </button>
        </>
      )}
      {lock?.hasPin && (
        <>
          <div className="button-row">
            <button disabled={busy} onClick={() => void act('lock', () => window.fask.lock(), '')}>
              <Icon name="lock" />
              {t('지금 잠그기')}
            </button>
            <button
              disabled={busy}
              aria-pressed={pinMode === 'change'}
              onClick={() => setPinMode(pinMode === 'change' ? null : 'change')}
            >
              {t('PIN 변경')}
            </button>
            <button
              className="danger"
              disabled={busy}
              aria-pressed={pinMode === 'remove'}
              onClick={() => setPinMode(pinMode === 'remove' ? null : 'remove')}
            >
              {t('PIN 제거')}
            </button>
          </div>
          {pinMode && pinField('current', '현재 PIN')}
          {pinMode === 'change' && (
            <>
              {pinField('next', '새 PIN')}
              {pinField('confirm', 'PIN 확인')}
            </>
          )}
          {pinMode && (
            <button
              disabled={busy || !pins.current || (pinMode === 'change' && (!pins.next || mismatch))}
              onClick={() =>
                void act(
                  'lock',
                  async () => {
                    if (pinMode === 'change') await window.fask.setPin(pins.current, pins.next)
                    else await window.fask.removePin(pins.current)
                    setPins({ current: '', next: '', confirm: '' })
                    setPinMode(null)
                  },
                  pinMode === 'change' ? t('PIN을 바꿨습니다.') : t('PIN을 제거했습니다.')
                )
              }
            >
              {pinMode === 'change' ? t('PIN 변경') : t('PIN 제거')}
            </button>
          )}
        </>
      )}
      {pins.confirm && mismatch && <small>{t('두 PIN이 다릅니다.')}</small>}
      {statusOf('lock')}
    </section>
  )

  return (
    <div className="settings-page profile-page">
      <aside className="settings-nav">
        <button className="settings-back" onClick={onClose}>
          <Icon name="back" />
          {t('돌아가기')}
        </button>
        <h2>{t('프로필')}</h2>
        <nav aria-label={t('프로필 항목')}>
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
      <section className="settings-main" aria-label={label}>
        <div className="settings-scroll">
          <div className="settings-body">
            <h2>{label}</h2>
            {category === 'basic' ? basic : security}
          </div>
        </div>
      </section>
    </div>
  )
}
