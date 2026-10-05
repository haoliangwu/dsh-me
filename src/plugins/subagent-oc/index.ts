/**
 * Profile-named OpenCode one-shot subagent provider. Every accepted run starts
 * a fresh `opencode run --standalone` CLI child in the delegating Session's
 * workspace and publishes the one-shot run after the process has spawned.
 *
 * @module dsh-me/plugins/subagent-oc
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import {
  assertPositiveFinite,
  NO_START_CAPABILITIES,
  resolveChildCwd,
  type ResolvedSubagentStartRequest,
  type SubagentCapabilities,
  type SubagentProvider,
} from '@deepseek-ai/dsh-subagent'
import {
  DEFAULT_DISPOSE_GRACE_MS,
  ocStartupFailure,
  resolveOcBinary,
  startOcRun,
  type OcRunSpec,
} from './run.ts'

export const name = 'subagent-oc'
export const inject = ['subagents', 'subprocess']

const DEFAULT_PROVIDER_NAME = 'oc'
const DEFAULT_BIN_PATH = 'opencode'
const DEFAULT_AGENT = 'orchestrator'

/** Deployment-owned OpenCode executable, agent, model, and process-release settings. */
export interface Config {
  /** Provider name on `ctx.subagents` (default `oc`). */
  providerName?: string
  /** OpenCode CLI executable; an absolute path or a name resolved on PATH. */
  binPath?: string
  /**
   * Native OpenCode model override (`provider/model#variant`); omitted to use
   * the deployment's OpenCode configuration.
   */
  model?: string
  /** OpenCode agent (persona) fixed for every run (default `orchestrator`). */
  agent?: string
  /** Auto-approve permissions that are not explicitly denied (`run --auto`). */
  autoApprove?: boolean
  /** Include thinking blocks in the run output (`run --thinking`). */
  showThinking?: boolean
  /** Explicit environment entries layered over the subprocess seam's scrubbed parent environment. */
  env?: Record<string, string>
  /**
   * Names of Host environment variables forwarded unchanged into the child
   * environment. The subprocess seam scrubs credential-shaped parent entries
   * (e.g. `*API_KEY*`), so a deployment key the child needs must be forwarded
   * explicitly. `env` entries with the same name win.
   */
  envFromProcess?: string[]
  /** Grace in milliseconds between managed-range termination tiers. */
  disposeGraceMs?: number
}

export const Config: z<Config> = z.object({
  providerName: z.string().min(1).default(DEFAULT_PROVIDER_NAME),
  binPath: z.string().min(1).default(DEFAULT_BIN_PATH),
  model: z.string().min(1),
  agent: z.string().min(1).default(DEFAULT_AGENT),
  autoApprove: z.boolean().default(false),
  showThinking: z.boolean().default(false),
  env: z.dict(z.string()).default({}),
  envFromProcess: z.array(z.string()).default([]),
  disposeGraceMs: z.number().default(DEFAULT_DISPOSE_GRACE_MS),
})

type ResolvedConfig = Omit<Required<Config>, 'model' | 'env' | 'envFromProcess'> & {
  model?: string
  env: Record<string, string>
}

class OcProvider implements SubagentProvider {
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false
  readonly name: string
  private readonly ctx: Context
  private readonly config: ResolvedConfig

  constructor(name: string, ctx: Context, config: ResolvedConfig) {
    this.name = name
    this.ctx = ctx
    this.config = config
  }

  start(request: ResolvedSubagentStartRequest) {
    const parentCwd = request.parent.session.header.cwd
    if (parentCwd === undefined) {
      throw new Error(
        'subagent-oc: no working directory for the child — delegate from a parent session that has one',
      )
    }
    let cwd: string
    try {
      cwd = resolveChildCwd(
        'subagent-oc',
        undefined,
        parentCwd,
      )
    } catch (error: unknown) {
      if (request.signal.aborted) {
        throw new Error(
          'subagent-oc: request was aborted before OpenCode startup',
        )
      }
      throw ocStartupFailure(error)
    }
    const spec: OcRunSpec = {
      cwd,
      binPath: this.config.binPath,
      ...this.config.model === undefined ? {} : { model: this.config.model },
      agent: this.config.agent,
      autoApprove: this.config.autoApprove,
      showThinking: this.config.showThinking,
      env: this.config.env,
      disposeGraceMs: this.config.disposeGraceMs,
      spawn: spawnSpec => this.ctx.subprocess.spawn(spawnSpec),
      onError: (error, stopReason) => {
        this.ctx.logger.warn(
          `subagent-oc "${this.name}": child run failed (${stopReason}): ${error.message}`,
        )
      },
    }
    return startOcRun(request, spec)
  }
}

/**
 * Register one Profile-named OpenCode provider. Resolving the OpenCode CLI
 * executable fails loud here, at plugin load, so a deployment without the
 * binary cannot come up with a provider that only fails when delegated to.
 * @param ctx - context carrying shared subagent and subprocess services.
 * @param config - registry name, binary, agent, optional model, flags, child environment, and disposal grace.
 */
export function apply(ctx: Context, config: Config): void {
  // Forwarded host env is snapshotted at apply: a later rotation of the host
  // variable does not reach already-published children (acceptable — the key
  // is read at load, matching how the seam scrubs at spawn time).
  const forwarded = Object.fromEntries(
    (config.envFromProcess ?? []).flatMap((name) => {
      const value = process.env[name]
      return value === undefined ? [] : [[name, value]]
    }),
  )
  const resolved: ResolvedConfig = {
    providerName: config.providerName ?? DEFAULT_PROVIDER_NAME,
    binPath: resolveOcBinary(config.binPath ?? DEFAULT_BIN_PATH),
    ...config.model === undefined ? {} : { model: config.model },
    agent: config.agent ?? DEFAULT_AGENT,
    autoApprove: config.autoApprove ?? false,
    showThinking: config.showThinking ?? false,
    env: { ...forwarded, ...config.env ?? {} },
    disposeGraceMs: config.disposeGraceMs ?? DEFAULT_DISPOSE_GRACE_MS,
  }
  assertPositiveFinite(
    'subagent-oc',
    'disposeGraceMs',
    resolved.disposeGraceMs,
  )
  if (resolved.disposeGraceMs > MAX_TIMER_DELAY_MS) {
    throw new Error(
      `subagent-oc: disposeGraceMs must be no greater than ${MAX_TIMER_DELAY_MS}`,
    )
  }
  ctx.subagents.registerProvider(new OcProvider(
    resolved.providerName,
    ctx,
    resolved,
  ))
}