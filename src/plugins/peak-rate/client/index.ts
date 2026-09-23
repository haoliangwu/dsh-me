/**
 * Web 🔥 2× peak-rate badge, browser half: one entry of the
 * `conversation.input.right` list slot (session scope). The badge shows in
 * the composer's trailing row, just left of the model trigger, while the
 * session's current model provider (read through the shared model directory
 * owned by ui-model-selection) is in the configured provider list and the
 * current time is peak-priced (weekday inside a peak window; weekends and
 * PRC legal holidays are all-day off-peak per the 2026-08-23 billing rule,
 * holidays added 2026-09-23). Export discipline:
 * packages/client/AGENTS.md.
 *
 * The peak-rate policy (providers, peak windows, multiplier, holiday dates)
 * is fetched from the host half through the Connection RPC channel
 * `/peak-rate` endpoint `config` (host reads schemastery Config from the
 * profile's cordis.patch.yml). An empty holiday set triggers up to three
 * delayed retries (the host's own holiday fetch can outlast the RPC), and a
 * `refresh` re-fetch covers date-boundary changes. The policy arrives
 * asynchronously; the badge stays hidden until the fetch settles, then
 * re-renders when it does.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input.right seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the ui-model-selection directory types + ctx.modelDirectories merge.
import type {} from '@deepseek-ai/dsh-client-ui-model-selection/client'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import { PeakRateBadge, type ConfigSource, type PluginConfig } from './PeakRateBadge.tsx'
import { en, zh, type PeakKey } from './locales.ts'

export type { PeakKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The peak-rate badge copy. */
    peak: PeakKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'peak'

/** RPC channel owned by the host half of this plugin. */
const CHANNEL = '/peak-rate'

/** Endpoint under {@link CHANNEL} returning the configured peak-rate policy. */
const ENDPOINT_CONFIG = 'config'

/** Host response payload for {@link ENDPOINT_CONFIG}. */
interface ConfigResponse {
  readonly providers: readonly string[]
  readonly peakWindows: readonly (readonly [number, number])[]
  readonly multiplier: number
  /** PRC legal holidays as Beijing `YYYY-MM-DD`; empty while the host fetch has not settled or failed (fail-open). */
  readonly holidays: readonly string[]
}

/** Delay before an empty-holiday fetch retry, in ms. Exceeds the host's 10 s holiday-fetch timeout so a slow-but-successful host fetch settles first. */
const HOLIDAY_RETRY_DELAY_MS = 15_000

/** Maximum number of empty-holiday fetch retries after the initial fetch. */
const MAX_HOLIDAY_RETRIES = 3

/** Required services: the contribution registry, locale, the model directory, and the Connection RPC carrier. */
export const inject = ['slots', 'locale', 'modelDirectories', 'connection', 'remote.session']

/**
 * Client plugin body: register the `peak` dictionaries and the composer's
 * trailing input-slot entry. Fetch the configured peak-rate policy from the
 * host half through the Connection RPC channel, retrying while the holiday
 * set stays empty; the badge stays hidden until the fetch settles.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'client-ui-peak-rate: dictionaries')

  // Reactive peak-rate policy: empty until the host RPC settles, then
  // republished on every fetch. The badge component subscribes through
  // useSyncExternalStore.
  let policy: PluginConfig = { providers: [], peakWindows: [], multiplier: 0, holidays: new Set() }
  const listeners = new Set<() => void>()
  let holidayRetryTimer: ReturnType<typeof setTimeout> | undefined
  let holidayRetriesLeft = MAX_HOLIDAY_RETRIES

  const publish = (next: PluginConfig): void => {
    if (Object.is(next, policy)) return
    policy = next
    for (const listener of [...listeners]) listener()
  }

  // Fetch the peak-rate policy from the host and republish it. When the
  // holiday set arrives empty — the host's own holiday fetch can outlive our
  // RPC (its per-request timeout is 10 s) — retry on a delay up to
  // MAX_HOLIDAY_RETRIES times so a slow-but-successful host fetch reaches the
  // badge without a reload. Retrying stops once the holidays are non-empty
  // or the retry cap is hit. Never throws; failed RPCs are left as-is.
  const fetchConfig = async (): Promise<void> => {
    const result = await ctx.connection.rpc.call(CHANNEL, ENDPOINT_CONFIG, {}) as RpcResult<ConfigResponse>
    if (!result.ok) return
    publish({
      providers: result.value.providers,
      peakWindows: result.value.peakWindows,
      multiplier: result.value.multiplier,
      holidays: new Set(result.value.holidays),
    })
    if (result.value.holidays.length === 0 && holidayRetriesLeft > 0 && holidayRetryTimer === undefined) {
      holidayRetriesLeft -= 1
      holidayRetryTimer = setTimeout(() => {
        holidayRetryTimer = undefined
        void fetchConfig()
      }, HOLIDAY_RETRY_DELAY_MS)
    }
  }
  /** Public re-fetch entry for the badge's date-change check. */
  const refresh = (): void => { void fetchConfig() }

  const configSource: ConfigSource = {
    getSnapshot: () => policy,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refresh,
  }

  ctx.effect(() => { void fetchConfig() }, 'client-ui-peak-rate: fetch config')
  ctx.effect(() => () => {
    if (holidayRetryTimer !== undefined) {
      clearTimeout(holidayRetryTimer)
      holidayRetryTimer = undefined
    }
  }, 'client-ui-peak-rate: dispose holiday retry timer')

  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right',
    id: 'dsh-ui-peak-rate',
    locale: NS,
    inject: sessionId => ({
      directory: ctx.modelDirectories.directoryFor(sessionId).store,
      config: configSource,
    }),
  }, PeakRateBadge))
}