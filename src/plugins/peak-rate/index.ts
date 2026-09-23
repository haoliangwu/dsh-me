/**
 * Web composer 🔥 2× peak-rate badge, node half.
 *
 * Mounts the host-plane Config carrier as a Connection RPC channel: the
 * browser half reads the validated provider list, peak windows, multiplier,
 * and PRC legal-holiday dates through
 * `ctx.connection.rpc.call('/peak-rate', 'config', {})`. There is no
 * in-process Service shared across the host/browser boundary — the only
 * transport is the Connection RPC channel.
 *
 * The holiday set is fetched from the holiday-cn feed in the background after
 * apply (current and next Beijing year, so sessions crossing Dec 31 stay
 * covered) and fails open: any fetch error logs a warning and leaves the set
 * empty, so the plugin never blocks boot and never throws.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import z from '@deepseek-ai/schemastery'
// Type-only import activates the optional webServer Context declaration.
import type {} from '@deepseek-ai/dsh-host-webserver'
import { beijingYear } from './beijing.ts'

/** Cordis plugin name. */
export const name = 'client-ui-peak-rate'

/**
 * Required services. The web route is attached at runtime via
 * `ctx.inject(['webServer'])` (vision-toolkit pattern) so non-web profiles
 * simply skip the channel instead of pending forever.
 */
export const inject = []

/** Plugin config: providers, peak windows, and multiplier for the peak badge. */
export interface Config {
  /** Provider ids that show the peak-rate badge (default: the official DeepSeek provider). */
  providers?: string[]
  /** Peak windows `[startHour, endHour)` UTC, left-closed right-open (default: [[1,4],[6,10]]). */
  peakWindows?: (readonly [number, number])[]
  /** Peak-rate multiplier vs off-peak rate (default: 2). */
  multiplier?: number
}

export const Config = z.object({
  providers: z.array(String).default(['deepseek-official']),
  peakWindows: z.transform(
    z.array(z.tuple([Number, Number])),
    (windows, options) => {
      const typed = windows as [number, number][]
      for (const [start, end] of typed) {
        if (!(start >= 0 && start < end && end <= 24)) {
          throw new z.ValidationError(`peak window [${start},${end}] must satisfy 0 <= start < end <= 24`, options)
        }
      }
      return typed
    },
  ).default([[1, 4], [6, 10]]),
  multiplier: z.number().default(2),
})

/** Response payload for the `config` endpoint. */
interface ConfigResponse {
  readonly providers: readonly string[]
  readonly peakWindows: readonly (readonly [number, number])[]
  readonly multiplier: number
  /** PRC legal holidays as Beijing `YYYY-MM-DD`; empty while the background fetch has not settled or failed (fail-open). */
  readonly holidays: readonly string[]
}

/** RPC channel owned by this plugin. */
const CHANNEL = '/peak-rate'

/** Endpoint under {@link CHANNEL} returning the configured peak-rate policy. */
const ENDPOINT_CONFIG = 'config'

/** China legal-holiday feed (NateScarlet/holiday-cn), one JSON document per year. */
const HOLIDAY_CN_URL_TEMPLATE = 'https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/{year}.json'

/** Per-request timeout for the holiday feed. */
const HOLIDAY_FETCH_TIMEOUT_MS = 10_000

/**
 * Fetch one year of PRC legal holidays from the holiday-cn feed. Only entries
 * with `isOffDay: true` count; make-up workdays (`isOffDay: false`) stay out
 * because the weekend rule already handles weekend make-up days (weekends are
 * all-day off-peak regardless of the calendar).
 * @param year - the calendar year to fetch.
 * @returns the year's holiday dates as `YYYY-MM-DD` strings.
 * @throws on network error, non-OK status, or a malformed payload.
 */
async function fetchHolidayYear(year: number): Promise<readonly string[]> {
  const url = HOLIDAY_CN_URL_TEMPLATE.replace('{year}', String(year))
  const response = await fetch(url, { signal: AbortSignal.timeout(HOLIDAY_FETCH_TIMEOUT_MS) })
  if (!response.ok) throw new Error(`holiday-cn ${year}: HTTP ${response.status}`)
  const payload = await response.json() as { days?: unknown }
  if (!Array.isArray(payload.days)) throw new Error(`holiday-cn ${year}: missing days array`)
  const dates: string[] = []
  for (const day of payload.days as Array<{ date?: unknown; isOffDay?: unknown }>) {
    if (day.isOffDay === true && typeof day.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day.date)) {
      dates.push(day.date)
    }
  }
  return dates
}

/** Outcome of one year's holiday fetch from the feed. */
interface HolidayYearFetch {
  readonly year: number
  readonly dates: readonly string[]
  /** True when the feed served the year's document; a tolerated next-year 404 sets this false. */
  readonly fetched: boolean
}

/**
 * Fetch the PRC legal holidays for the given Beijing year and the following
 * one, merged into one sorted, de-duplicated `YYYY-MM-DD` list.
 *
 * Fails open: each failing year is logged as a warning and skipped, so the
 * plugin boots and serves the weekday-only rule unchanged. The following
 * year's document appears only after the State Council's annual announcement
 * (typically Nov/Dec), so a 404 for it is routine and logs at debug instead
 * of warn; current-year failures and other errors still warn.
 * @param ctx - host plugin context used for logging.
 * @param thisYear - the current Beijing calendar year.
 * @returns the merged holiday dates plus the Beijing years whose documents
 *   were actually retrieved; never throws.
 */
async function fetchHolidays(ctx: Context, thisYear: number): Promise<{ readonly dates: readonly string[]; readonly yearsFetched: ReadonlySet<number> }> {
  const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
  const nextYear = thisYear + 1
  const results = await Promise.allSettled([
    fetchHolidayYear(thisYear).then((dates): HolidayYearFetch => ({ year: thisYear, dates, fetched: true })),
    fetchHolidayYear(nextYear)
      .then((dates): HolidayYearFetch => ({ year: nextYear, dates, fetched: true }))
      .catch((error: unknown): HolidayYearFetch => {
        if (error instanceof Error && error.message.includes('HTTP 404')) {
          ctx.logger.debug(`[client-ui-peak-rate] holiday-cn ${nextYear}: not published yet (HTTP 404); skipped`)
          return { year: nextYear, dates: [], fetched: false }
        }
        throw error
      }),
  ])
  const dates = new Set<string>()
  const yearsFetched = new Set<number>()
  for (const result of results) {
    if (result.status === 'fulfilled') {
      for (const date of result.value.dates) dates.add(date)
      if (result.value.fetched) yearsFetched.add(result.value.year)
    } else {
      ctx.logger.warn(`[client-ui-peak-rate] holiday-cn fetch failed: ${reason(result.reason)}; degrade to no holidays (fail-open)`)
    }
  }
  return { dates: [...dates].sort(), yearsFetched }
}

/**
 * Mount the host RPC handler that returns the validated peak-rate policy.
 * @param ctx - host plugin context carrying the Connection service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const response = {
    providers: config.providers as string[],
    peakWindows: config.peakWindows as (readonly [number, number])[],
    multiplier: config.multiplier as number,
  }
  // PRC legal holidays, filled asynchronously after apply. Read at request
  // time below, so a slow fetch eventually appears in the served policy
  // without a restart; fetchHolidays never throws (fail-open).
  let holidays: readonly string[] = []
  // Beijing years whose holiday documents were actually retrieved; a current
  // year absent from the set triggers a refetch on the next config request,
  // so a host running across a year boundary picks up the new year's data.
  const fetchedYears = new Set<number>()
  let holidayFetchInFlight = false
  // Fire one holiday fetch unless the current Beijing year is already fetched
  // or another fetch is in flight; marks the years actually retrieved and
  // never throws (fail-open).
  const fetchHolidaysIfNeeded = (): void => {
    const thisYear = beijingYear(new Date())
    if (holidayFetchInFlight || fetchedYears.has(thisYear)) return
    holidayFetchInFlight = true
    void fetchHolidays(ctx, thisYear).then(({ dates, yearsFetched }) => {
      holidays = dates
      for (const year of yearsFetched) fetchedYears.add(year)
    }).finally(() => { holidayFetchInFlight = false })
  }
  // Initial boot fetch; later year-boundary refetches come from the config handler.
  fetchHolidaysIfNeeded()
  // dsh-client-connection 0.1.5-rc.2: connection.rpc.handle() is unusable from
  // the profile plugin tree — the connection service is provided inside the
  // web-app boot tree, so a profile fiber's inject wait never activates.
  // Register a plain webServer prefix route speaking the same
  // client-request/server-response envelopes instead.
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'prefix',
      path: CHANNEL,
      handler: (req, res) => {
        void serveChannel(req, res, CHANNEL, (endpoint) => {
          if (endpoint === ENDPOINT_CONFIG) {
            fetchHolidaysIfNeeded()
            const value: ConfigResponse = { ...response, holidays }
            return Promise.resolve({ ok: true as const, value })
          }
          return Promise.resolve({
            ok: false as const,
            error: { code: 'internal', message: `unknown endpoint ${endpoint}`, details: {} },
          })
        })
      },
    }), 'dsh-ui-peak-rate: /peak-rate channel')
  })
}

/**
 * Serve one Connection-RPC channel over a plain webServer route, mirroring
 * dsh-client-connection's rpcFetchHandler semantics (POST-only, JSON
 * client-request envelope, server-response envelope out) so the browser-side
 * `connection.rpc.call()` keeps working unchanged.
 */
async function serveChannel(
  req: IncomingMessage,
  res: ServerResponse,
  channel: string,
  handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult<unknown>>,
): Promise<void> {
  const writeJson = (status: number, body: unknown): void => {
    const bytes = Buffer.from(JSON.stringify(body))
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Length', String(bytes.length))
    res.writeHead(status)
    res.end(bytes)
  }
  const endpoint = endpointFromPath(channel, req.url ?? '/')
  if (req.method !== 'POST' || endpoint === undefined) {
    res.writeHead(404)
    res.end('not found')
    return
  }
  if (req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    res.writeHead(415)
    res.end('content type must be application/json')
    return
  }
  let body: unknown
  try {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
      chunks.push(part)
    }
    body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } catch {
    res.writeHead(400)
    res.end('body is not JSON')
    return
  }
  const message = (body ?? {}) as { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown }
  const respond = (result: RpcResult<unknown>): void =>
    writeJson(200, { type: 'server-response', rpcId: typeof message.rpcId === 'string' ? message.rpcId : '', result })
  if (typeof body !== 'object' || body === null || message.type !== 'client-request'
    || typeof message.rpcId !== 'string' || typeof message.method !== 'string') {
    respond({
      ok: false,
      error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: {} },
    } as unknown as RpcResult<unknown>)
    return
  }
  if (message.method !== endpoint) {
    respond({
      ok: false,
      error: {
        code: 'gateway/bad-request',
        message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
        details: {},
      },
    } as unknown as RpcResult<unknown>)
    return
  }
  const controller = new AbortController()
  req.once('aborted', () => controller.abort())
  req.socket.once('close', () => controller.abort())
  try {
    respond(await handler(endpoint, message.payload, controller.signal))
  } catch (error) {
    res.writeHead(500)
    res.end(`handler failure: ${String(error)}`)
  }
}

/** Extract and validate the endpoint segment below the channel prefix. */
function endpointFromPath(channel: string, pathname: string): string | undefined {
  if (!pathname.startsWith(`${channel}/`)) return undefined
  const endpoint = pathname.slice(channel.length + 1)
  if (endpoint.split('/').some((segment) => segment === '' || segment === '.' || segment === '..' || !/^[A-Za-z0-9_$.-]+$/.test(segment))) return undefined
  return endpoint
}