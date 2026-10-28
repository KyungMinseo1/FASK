// HubTransport over the service bridge. Only an address and path leave the page; the token and
// certificate pin stay in the native session.
import { HubError, toHubError, type HubIdentity, type HubTransport } from '../transport'
import { BridgeError, type Bridge } from './bridge'

const codeOf = (e: unknown): unknown =>
  e instanceof BridgeError || e instanceof HubError ? e.code : undefined

const asHubError = (e: unknown): HubError => {
  const code = codeOf(e)
  if (code === 'CLOSED') return new HubError('연결이 해제되었습니다.', 'CLOSED')
  return toHubError(code)
}

export function bridgeTransport(bridge: Bridge): HubTransport<HubIdentity> {
  return {
    async request(_p, address, method, path, body, timeoutMs) {
      try {
        return await bridge.call<{ status: number; body: string }>('request', {
          address,
          method,
          path,
          ...(body === undefined ? {} : { body }),
          timeoutMs
        })
      } catch (e) {
        throw asHubError(e)
      }
    },
    async openEvents(_p, address, onEvent, onClose) {
      const id = crypto.randomUUID()
      let live = true
      // Subscribed before opening so no early event is missed.
      const off = bridge.onPush((push) => {
        if (!live) return
        if (push.event === 'hubEvent' && push.payload.id === id)
          onEvent(push.payload.event, push.payload.data)
        else if (push.event === 'hubClosed' && push.payload.id === id) {
          live = false
          off()
          onClose(asHubError(new BridgeError(push.payload.error, '')).code)
        } else if (push.event === 'sessionInvalidated') {
          live = false
          off()
          onClose('CLOSED')
        }
      })
      try {
        await bridge.call('openEvents', { id, address })
      } catch (e) {
        live = false
        off()
        // A JS-side timeout may race a late native open; make sure it does not linger.
        void bridge.call('closeEvents', { id }).catch(() => {})
        throw asHubError(e)
      }
      return () => {
        if (!live) return
        live = false
        off()
        void bridge.call('closeEvents', { id }).catch(() => {})
      }
    }
  }
}
