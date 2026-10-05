/**
 * One-shot OpenCode child lifecycle: spawn the real `opencode run --standalone`
 * CLI through the subprocess seam, publish only after the spawn succeeds,
 * flatten post-publication failures into a settled result, and dispose to
 * managed-range quiescence.
 *
 * @module dsh-me/plugins/subagent-oc/run
 */

import { randomUUID } from 'node:crypto'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import {
  settleRunResult,
  subprocessRunHandle,
  type ResolvedSubagentStartRequest,
  type SubagentResult,
  type SubagentRun,
  type SubagentStopReason,
} from '@deepseek-ai/dsh-subagent'
import type {
  SubprocessHandle,
  SubprocessOutcome,
  SubprocessSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

/** Default POSIX grace between subprocess termination tiers. */
export const DEFAULT_DISPOSE_GRACE_MS = 3_000

/** Safe diagnostic byte ceiling for the settled result (the seam contract). */
const DIAGNOSTIC_BYTE_LIMIT = 4_096

/** In-memory tail caps for the collect-mode output streams. */
const STDOUT_MAX_BYTES = 1_000_000
const STDERR_MAX_BYTES = 64_000

type OcFailureStage = 'initialize' | 'process' | 'teardown'

interface OcFailureFacts {
  readonly stage: OcFailureStage
  readonly outcome?: SubprocessOutcome | undefined
}

function failureDiagnostic(facts: OcFailureFacts): string {
  const fields = ['product: OpenCode', `stage: ${facts.stage}`]
  const processFields = [
    ['exit code', facts.outcome?.exitCode],
    ['signal', facts.outcome?.signal],
  ] as const
  for (const [label, value] of processFields) {
    if (value !== null && value !== undefined) fields.push(`${label}: ${value}`)
  }
  return `Product subagent failure (${fields.join('; ')})`
}

class OcRunFailure extends Error {
  readonly facts: OcFailureFacts

  constructor(facts: OcFailureFacts, cause?: unknown) {
    super(
      `subagent-oc: ${failureDiagnostic(facts)}`,
      cause === undefined ? undefined : { cause },
    )
    this.name = 'OcRunFailure'
    this.facts = facts
  }
}

/**
 * Hide an unpublished Host failure behind fixed safe startup facts.
 * @param cause Original Host failure retained for internal diagnostics.
 * @returns A startup failure whose message contains only fixed safe facts.
 */
export function ocStartupFailure(cause: unknown): Error {
  return new OcRunFailure({ stage: 'initialize' }, cause)
}

function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the OpenCode CLI executable: an absolute configured path is
 * validated in place; a bare name is located on `PATH`. Fails loud at plugin
 * load when the deployment has no usable binary.
 * @param binPath - configured executable (absolute path or PATH name).
 * @param pathEnv - `PATH`-style search list (defaults to the Host `PATH`).
 * @returns the resolved absolute executable path.
 */
export function resolveOcBinary(
  binPath: string,
  pathEnv: string = process.env.PATH ?? '',
): string {
  if (isAbsolute(binPath)) {
    if (!isExecutableFile(binPath)) {
      throw new Error(`subagent-oc: configured binPath is not an executable file: ${binPath}`)
    }
    return binPath
  }
  const seen = new Set<string>()
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0 || seen.has(dir)) continue
    seen.add(dir)
    const candidate = join(dir, binPath)
    if (isExecutableFile(candidate)) return candidate
  }
  throw new Error(
    `subagent-oc: cannot resolve "${binPath}" on PATH — install OpenCode or set binPath`,
  )
}

/**
 * Fixed non-interactive command for one child run: a fresh `opencode run`
 * against its own private server (`--standalone`, no background daemon), one
 * task message, and no session continuation (`--session`/`--continue`/`--fork`
 * are deliberately never passed).
 * @param spec - binary, model, agent, and flag switches.
 * @param task - the single task text (text blocks joined by newlines).
 * @returns the spawned `argv`.
 */
export function ocRunArgv(
  spec: Pick<OcRunSpec, 'binPath' | 'model' | 'agent' | 'autoApprove' | 'showThinking'>,
  task: string,
): string[] {
  const argv = [spec.binPath, 'run', '--standalone', '--agent', spec.agent]
  if (spec.model !== undefined) argv.push('--model', spec.model)
  if (spec.autoApprove) argv.push('--auto')
  if (spec.showThinking) argv.push('--thinking')
  argv.push(task)
  return argv
}

/**
 * Validate and preserve the one-shot task before crossing the process
 * boundary.
 * @param prompt - task content accepted from the shared subagent service.
 * @returns the exact non-empty text block sequence.
 */
export function textTask(prompt: readonly ContentBlock[]): string[] {
  if (prompt.length === 0) {
    throw new Error('subagent-oc: the one-shot task must contain only text blocks')
  }
  const texts: string[] = []
  for (const block of prompt) {
    if (block.type !== 'text') {
      throw new Error('subagent-oc: the one-shot task must contain only text blocks')
    }
    texts.push(block.text)
  }
  if (texts.every(text => text.trim().length === 0)) {
    throw new Error('subagent-oc: the one-shot task must not be empty')
  }
  return texts
}

function textBlocks(text: string): ContentBlock[] {
  return text.length === 0 ? [] : [{ type: 'text', text }]
}

function limitUtf8Bytes(text: string, limit: number): string {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= limit) return text
  const truncated = Buffer.from(text, 'utf8').subarray(0, limit).toString('utf8')
  return `${truncated}…`
}

function collectedText(child: SubprocessHandle, stream: 'stdout' | 'stderr'): string {
  const reader = child.collected[stream]
  return reader === undefined ? '' : reader.readFrom(0).text
}

/** Fully resolved inputs for one OpenCode CLI run. */
export interface OcRunSpec {
  /** Parent Session workspace, also the child `cwd`. */
  readonly cwd: string
  /** Resolved absolute OpenCode CLI executable. */
  readonly binPath: string
  /** Profile-selected native model (`provider/model#variant`); omitted to use OpenCode config. */
  readonly model?: string
  /** OpenCode agent (persona) fixed for every run. */
  readonly agent: string
  /** Auto-approve permissions that are not explicitly denied. */
  readonly autoApprove: boolean
  /** Include thinking blocks in the run output. */
  readonly showThinking: boolean
  /** Explicit environment entries layered after the shared scrub. */
  readonly env: Record<string, string>
  /** Subprocess termination grace passed to the shared managed-range owner. */
  readonly disposeGraceMs: number
  /** Shared subprocess service spawn operation. */
  readonly spawn: (spec: SubprocessSpawnSpec) => SubprocessHandle
  /** Diagnostic sink for a post-publication error flattened into a result. */
  readonly onError?: (error: Error, stopReason: SubagentStopReason) => void
}

function thrown(value: unknown): Error {
  /* v8 ignore next -- typed spawn/done failures reject with Error. */
  return value instanceof Error ? value : new Error(String(value))
}

/**
 * Start the real `opencode run --standalone` child and publish its one-shot
 * run.
 * @param request - resolved shared subagent request.
 * @param spec - Workspace, executable, environment, flags, and process policy.
 * @returns the published run after the spawn succeeds.
 */
export async function startOcRun(
  request: ResolvedSubagentStartRequest,
  spec: OcRunSpec,
): Promise<SubagentRun> {
  const texts = textTask(request.prompt)
  if (request.signal.aborted) {
    throw new Error('subagent-oc: request was aborted before OpenCode startup')
  }
  const task = texts.join('\n')

  let child: SubprocessHandle
  try {
    child = spec.spawn({
      argv: ocRunArgv(spec, task),
      cwd: spec.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: STDOUT_MAX_BYTES },
        stderr: { maxBytes: STDERR_MAX_BYTES },
      },
      graceMs: spec.disposeGraceMs,
      env: spec.env,
    })
  } catch (error: unknown) {
    throw ocStartupFailure(error)
  }

  const runAbort = new AbortController()
  const requestCancel = (): void => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error('subagent-oc: run cancelled locally'))
    child.terminate()
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  const collectOutput = (): ContentBlock[] => textBlocks(collectedText(child, 'stdout').trim())
  let diagnostic: string | undefined
  const recordDiagnostic = (facts: OcFailureFacts, stderrTail: string): string => {
    const safe = failureDiagnostic(facts)
    diagnostic = stderrTail.trim().length === 0
      ? safe
      : `${safe}\n${limitUtf8Bytes(stderrTail.trim(), DIAGNOSTIC_BYTE_LIMIT)}`
    return diagnostic
  }

  const result: Promise<SubagentResult> = settleRunResult({
    attempt: async () => {
      let outcome: SubprocessOutcome
      try {
        outcome = await child.done
      } catch (error: unknown) {
        throw new OcRunFailure({ stage: 'process' }, thrown(error))
      }
      const stdoutText = collectedText(child, 'stdout').trim()
      if (outcome.exitCode === 0) {
        return { output: textBlocks(stdoutText), stopReason: 'completed' }
      }
      const stderrTail = collectedText(child, 'stderr')
      return {
        output: textBlocks(stdoutText),
        diagnostic: recordDiagnostic({ stage: 'process', outcome }, stderrTail),
        stopReason: 'error',
      }
    },
    collectOutput,
    collectDiagnostic: () => diagnostic,
    cancelled: () => runAbort.signal.aborted,
    onError: spec.onError,
    signal: request.signal,
    onAbort,
  })

  const disposeProcess = async (): Promise<void> => {
    child.terminate()
    try {
      await child.waitForExit()
    } catch {
      // Exit observation is auxiliary; done remains the outcome authority.
    }
    await child.done.catch(() => {})
  }

  return subprocessRunHandle({
    id: randomUUID() as SessionId,
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: disposeProcess,
  })
}