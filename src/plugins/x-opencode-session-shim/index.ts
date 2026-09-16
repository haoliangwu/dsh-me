/**
 * x-opencode-session-shim, node half.
 *
 * OpenCode Go (pi-ai provider `opencode-go`, endpoint https://opencode.ai/zen/go)
 * rejects requests without `x-opencode-session` (HTTP 400 MissingSessionID) and
 * neither pi-ai (<=0.85.1) nor dsh's llm-pi-ai adapter exposes a per-request
 * header seam, so this plugin patches the host-process `globalThis.fetch`
 * (effect-scoped; the original is restored on dispose) and stamps the header
 * with the current dsh session id for every request to that endpoint.
 *
 * Session attribution: dsh's agent registry keeps an AsyncLocalStorage
 * initiator scope, and the agent loop kicks every turn inside it
 * (dsh-agent-loop runs `ctx.agents.withInitiator(agent, () => this.kick())`),
 * so any LLM fetch issued within a turn inherits the initiating Agent. Calls
 * outside any initiator boundary share the stable fallback id.
 */
import type { Context } from '@deepseek-ai/cordis'

/** Cordis plugin name. */
export const name = 'x-opencode-session-shim'

/** Required services: the agent registry (initiator scope). */
export const inject = ['agents']

/** Header OpenCode Go requires on every request. */
const HEADER_NAME = 'x-opencode-session'

/** OpenCode Go endpoint prefix every provider API (anthropic/openai) shares. */
const OPENCODE_GO_ORIGIN = 'https://opencode.ai/zen/go'

/** Stable id for agentless calls (no initiator boundary active). */
const AGENTLESS = 'dsh'

/** Extract the request URL from any fetch input form. */
function requestUrl(input: RequestInfo | URL): string | undefined {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

/** Resolve the session id a request should be stamped with. */
export function sessionValueFor(currentInitiator: () => { id: string } | undefined): string {
  try {
    return String(currentInitiator()?.id ?? AGENTLESS)
  } catch {
    // The registry refuses reads after disposal; those requests are agentless.
    return AGENTLESS
  }
}

/** Install the fetch patch; disposal restores the original fetch. */
export function apply(ctx: Context): void {
  const agents = ctx.agents
  const logger = ctx.logger
  const original = globalThis.fetch
  const patched: typeof fetch = (input, init) => {
    const url = requestUrl(input)
    if (url === undefined || !url.startsWith(OPENCODE_GO_ORIGIN)) return original(input, init)
    const session = sessionValueFor(() => agents.currentInitiator())
    const headers = new Headers(init?.headers)
    if (init === undefined && input instanceof Request) {
      for (const [key, value] of input.headers) headers.set(key, value)
    }
    headers.set(HEADER_NAME, session)
    // console over ctx.logger: the host filters info-level plugin logs, but
    // this line is the ops-visible proof of what we sent to the gateway
    console.info(`[x-opencode-session-shim] opencode-go: ${HEADER_NAME}: ${session}`)
    if (init === undefined && input instanceof Request) {
      return original(new Request(input, { headers }), undefined)
    }
    return original(input, { ...init, headers })
  }
  globalThis.fetch = patched
  // cordis ctx.effect runs the callback immediately and treats its RETURN
  // value as the disposer — restore must be returned, not run inline.
  ctx.effect((): (() => void) => () => {
    globalThis.fetch = original
  }, 'x-opencode-session-shim: restore globalThis.fetch')
}
