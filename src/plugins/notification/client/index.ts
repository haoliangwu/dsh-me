/**
 * Web dsh-ui-notification, browser half: desktop notifications when a
 * mirrored session errors, completes (max-tokens included), the agent asks a
 * question, or a tool permission approval is pending — only while the
 * document is hidden. Config toggles are fetched once from the host half
 * through the Connection RPC channel `/notification` endpoint `config`; the
 * browser Notification API fires with permission requested lazily on the
 * first eligible trigger.
 *
 * Completion/error: every Session in the mirrored list is watched through
 * `ctx.sessions.binding(id).eventSource`; `append` changes are scanned for
 * `turn/end`, whose reason maps to an outcome per spec. Question/approval:
 * the shipped answerers claim the `user-questions/request` and
 * `approval/request` waterfalls before profile plugins load, so the trigger
 * is read from `ctx.uiSession.sessionStatus` instead — 0.1.7's
 * pending-interaction face, a per-session row publishing the
 * highest-precedence pending interaction; new question and approval entries
 * fire, entries already pending at plugin start are seeded seen without
 * re-notifying, unknown domains are marked seen without firing.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConnectionRpcResult as RpcResult } from '@deepseek-ai/dsh-client-connection'
import {
  assistantTurnText,
  bodyForTurnEnd,
  pendingInteractionNotifications,
  playChime,
  shouldNotify,
  titleFor,
  turnEndOutcome,
  type AudioContextLike,
  type NotifyFn,
  type PendingInteractionShape,
  type SessionEventLikeEntryShape,
  type TurnEndReasonShape,
} from './notification.ts'

/** RPC channel owned by the host half of this plugin. */
const CHANNEL = '/notification'

/** Endpoint under {@link CHANNEL} returning the configured trigger toggles. */
const ENDPOINT_CONFIG = 'config'

/** Host response payload for {@link ENDPOINT_CONFIG}. */
interface ConfigResponse {
  readonly notifyCompletion: boolean
  readonly notifyError: boolean
  readonly notifyQuestion: boolean
  readonly notifyApproval: boolean
  /** Play the synthesized chime instead of the OS default sound. */
  readonly notifySound: boolean
}

/** Default toggles while the host fetch is in flight or absent. */
const DEFAULT_CONFIG: ConfigResponse = {
  notifyCompletion: true,
  notifyError: true,
  notifyQuestion: true,
  notifyApproval: true,
  notifySound: true,
}

/** Structural session-event entry/change faces the browser session window exposes. */
interface SessionWindowShape {
  readonly entries: readonly SessionEventLikeEntryShape[]
  readonly change: { readonly kind: string; readonly entries?: readonly SessionEventLikeEntryShape[] }
}

/** One session's status row: only the pending-interaction face is read. */
interface SessionStatusRowShape {
  readonly pendingInteraction: PendingInteractionShape | undefined
}

/** The slices of the client Context this plugin reads (structural). */
interface NotificationCtx {
  connection: { rpc: { call(channel: string, endpoint: string, payload: unknown): Promise<RpcResult<unknown>> } }
  sessions: {
    list: {
      subscribe(listener: () => void): () => void
      getSnapshot(): { readonly ids: readonly string[]; readonly byId: Record<string, { readonly displayTitle: string } | undefined> }
    }
    binding(id: string): { readonly sessionId: string; readonly eventSource: { subscribe(listener: () => void): () => void; getSnapshot(): SessionWindowShape } } | undefined
  }
  uiSession: {
    readonly sessionStatus: {
      subscribe(listener: () => void): () => void
      getSnapshot(): ReadonlyMap<string, SessionStatusRowShape>
    }
  }
}

/** Required services: the Connection RPC carrier, the sessions mirror, and the pending-interaction publisher. */
export const inject = ['connection', 'sessions', 'uiSession']

/**
 * Client plugin body: fetch trigger toggles once, watch every mirrored
 * session's event window for `turn/end`, and diff `uiSession
 * .pendingInteractions` for new questions. All subscriptions are
 * effect-scoped disposers.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const scoped = ctx as unknown as NotificationCtx
  const logger = ctx.logger

  // Toggled config, defaults until the host channel settles (once).
  let config: ConfigResponse = { ...DEFAULT_CONFIG }
  ctx.effect(async () => {
    try {
      const result = await scoped.connection.rpc.call(CHANNEL, ENDPOINT_CONFIG, {}) as RpcResult<ConfigResponse>
      if (result.ok && typeof result.value === 'object' && result.value !== null) {
        config = {
          notifyCompletion: result.value.notifyCompletion ?? config.notifyCompletion,
          notifyError: result.value.notifyError ?? config.notifyError,
          notifyQuestion: result.value.notifyQuestion ?? config.notifyQuestion,
          notifyApproval: result.value.notifyApproval ?? config.notifyApproval,
          notifySound: result.value.notifySound ?? config.notifySound,
        }
      }
    } catch (error) {
      logger.warn('dsh-ui-notification: config fetch failed, using defaults', error)
    }
    return () => {}
  }, 'dsh-ui-notification: fetch config')

  // Lazy permission: requested once on the first eligible trigger; denied or
  // unsupported stays silent forever after (spec).
  let permission: 'unrequested' | 'requesting' | 'granted' | 'denied' = 'unrequested'
  const notify: NotifyFn = (title, body) => {
    void notifyWithApi(title, body, config.notifySound, () => permission, state => { permission = state })
  }

  // Visibility + config-toggle gate (the tested shouldNotify) then emit.
  const fire = (type: 'completion' | 'error', title: string, body: string): void => {
    const enabled = type === 'error' ? config.notifyError : config.notifyCompletion
    if (shouldNotify(document.visibilityState, enabled)) notify(title, body)
  }

  // ── turn/end watcher over every mirrored session ─────────────────────────
  const watched = new Map<string, { dispose: () => void }>()
  const onWindowChange = (sessionId: string, snapshot: SessionWindowShape): void => {
    if (snapshot.change.kind !== 'append' || snapshot.change.entries === undefined) return
    for (const entry of snapshot.change.entries) {
      if (entry.type !== 'event' || entry.event.type !== 'turn/end') continue
      const data = entry.event.data as { turn?: unknown; reason?: TurnEndReasonShape } | undefined
      if (typeof data?.turn !== 'number' || data.reason === undefined) continue
      const outcome = turnEndOutcome(data.reason)
      if (outcome === null) continue // aborted / blocked / interrupted: skip
      const name = sessionName(sessionId)
      if (outcome.type === 'error') {
        fire('error', titleFor('error', name), outcome.message)
      } else {
        const body = bodyForTurnEnd(outcome, assistantTurnText(snapshot.entries, data.turn))
        fire('completion', titleFor('completion', name), body)
      }
    }
  }
  const reconcileSessions = (): void => {
    const snapshot = scoped.sessions.list.getSnapshot()
    const ids = new Set(snapshot.ids)
    for (const [id, watcher] of watched) {
      if (!ids.has(id)) {
        watcher.dispose()
        watched.delete(id)
      }
    }
    for (const id of snapshot.ids) {
      if (watched.has(id)) continue
      const binding = scoped.sessions.binding(id)
      if (binding === undefined) continue
      const dispose = binding.eventSource.subscribe(() => {
        onWindowChange(binding.sessionId, binding.eventSource.getSnapshot())
      })
      watched.set(id, { dispose })
    }
  }
  ctx.effect(() => {
    const dispose = scoped.sessions.list.subscribe(reconcileSessions)
    reconcileSessions()
    return dispose
  }, 'dsh-ui-notification: watch mirrored sessions')

  // ── question/approval trigger: sessionStatus (shipped answerers claim the
  // ── user-questions/request and approval/request waterfalls before profile
  // ── plugins load and publish each pending question/approval as its
  // ── session's pendingInteraction) ───────────────────────────────────────
  let seenKeys: ReadonlySet<string> = new Set()
  const pendingInteractionsOf = (snapshot: ReadonlyMap<string, SessionStatusRowShape>): ReadonlyMap<string, PendingInteractionShape> => {
    const interactions = new Map<string, PendingInteractionShape>()
    for (const [sessionId, row] of snapshot) {
      const interaction = row.pendingInteraction
      if (interaction === undefined) continue
      interactions.set(sessionId, interaction)
    }
    return interactions
  }
  const reconcileInteractions = (): void => {
    const { keys, fired } = pendingInteractionNotifications(seenKeys, pendingInteractionsOf(scoped.uiSession.sessionStatus.getSnapshot()))
    if (keys.length > 0) seenKeys = new Set([...seenKeys, ...keys])
    for (const item of fired) {
      const enabled = item.kind === 'approval' ? config.notifyApproval : config.notifyQuestion
      if (!shouldNotify(document.visibilityState, enabled)) continue
      notify(titleFor(item.kind, sessionName(item.sessionId)), item.body)
    }
  }
  ctx.effect(() => {
    // Seed the seen-set from the initial snapshot without notifying: an
    // interaction already pending before plugin load (HMR/reconnect
    // re-delivery) must not re-fire; a fresh page load legitimately
    // re-notifies it.
    const initial = pendingInteractionsOf(scoped.uiSession.sessionStatus.getSnapshot())
    seenKeys = new Set([...initial.values()].map(interaction => interaction.key))
    const dispose = scoped.uiSession.sessionStatus.subscribe(reconcileInteractions)
    return dispose
  }, 'dsh-ui-notification: watch pending interactions')

  function sessionName(sessionId: string): string {
    return scoped.sessions.list.getSnapshot().byId[sessionId]?.displayTitle ?? sessionId
  }
}

/**
 * Request Notification permission lazily and emit once granted; every other
 * state (denied, already requesting, unsupported browser) stays silent. The
 * OS default sound is suppressed (`silent: true`); when `sound` is set the
 * synthesized chime replaces it.
 * @param title - the notification title.
 * @param body - the notification body.
 * @param sound - whether to play the synthesized chime on emit.
 * @param readState - current permission state reader (test seam).
 * @param writeState - permission state writer (test seam).
 */
export async function notifyWithApi(
  title: string,
  body: string,
  sound: boolean,
  readState: () => 'unrequested' | 'requesting' | 'granted' | 'denied',
  writeState: (next: 'unrequested' | 'requesting' | 'granted' | 'denied') => void,
): Promise<void> {
  const Api = (globalThis as { Notification?: NotificationApi }).Notification
  if (Api === undefined || typeof Api.requestPermission !== 'function') return
  const emit = (): void => {
    const notification = new Api(title, { body, silent: true })
    notification.onclick = () => {
      globalThis.focus()
      notification.close()
    }
    if (sound) chimeSound()
  }
  const current = readState()
  if (current === 'granted') {
    emit()
    return
  }
  if (current !== 'unrequested') return // denied or already requesting
  writeState('requesting')
  try {
    const state = await Api.requestPermission()
    writeState(state === 'granted' ? 'granted' : 'denied')
    if (state === 'granted') emit()
  } catch {
    writeState('denied')
  }
}

/** Lazy singleton audio context (browser half, one page lifetime). */
let chimeAudioContext: (AudioContextLike & { resume(): Promise<void> }) | undefined

/**
 * Play the synthesized chime: acquire the real AudioContext once per page,
 * resume it (autoplay-policy: the user has interacted with dsh before any
 * notification fires, so this normally resolves; a failure just stays silent)
 * and schedule the two tones.
 */
function chimeSound(): void {
  const Ctor = (globalThis as { AudioContext?: new () => AudioContextLike & { resume(): Promise<void> } }).AudioContext
  if (Ctor === undefined) return
  if (chimeAudioContext === undefined) chimeAudioContext = new Ctor()
  void chimeAudioContext.resume().catch(() => {})
  playChime(chimeAudioContext)
}

/** Structural Notification API surface (denied/unsupported → silent). */
interface NotificationApi {
  readonly permission: string
  requestPermission(): Promise<string>
  new (title: string, options?: { readonly body?: string; readonly silent?: boolean }): {
    onclick: ((this: unknown, ev: unknown) => void) | null
    close(): void
  }
}