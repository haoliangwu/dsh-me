/**
 * One-shot OpenCode child lifecycle: spawn the real `opencode run --standalone`
 * CLI through the subprocess seam, publish only after the spawn succeeds,
 * flatten post-publication failures into a settled result, and dispose to
 * managed-range quiescence.
 *
 * Diagnostics stay safe by construction: the settled `diagnostic` carries only
 * fixed product/stage/exit facts, NEVER child stderr (which may contain paths,
 * environment echoes, or file contents). Child stderr is forwarded live to the
 * Host stderr, mirroring the official subagent-codex provider.
 *
 * @module dsh-me/plugins/subagent-oc/run
 */

import { randomUUID } from 'node:crypto'
import { accessSync, constants, statSync, writeFileSync } from 'node:fs'
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

/** In-memory tail cap for the collect-mode stdout stream. */
const STDOUT_MAX_BYTES = 1_000_000

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

/** Fixed truncation marker appended when the collect tail lost the head. */
function truncationMarker(): string {
  return `\n\n[subagent-oc: stdout exceeded ${STDOUT_MAX_BYTES} bytes; head discarded]`
}

interface StdoutSnapshot {
  readonly text: string
  readonly truncated: boolean
}

function snapshotStdout(child: SubprocessHandle): StdoutSnapshot {
  const reader = child.collected.stdout
  if (reader === undefined) return { text: '', truncated: false }
  const read = reader.readFrom(0)
  return { text: read.text, truncated: read.lossy }
}

/** Settled output blocks; a lost collect head is never silent. */
function finalOutput(snapshot: StdoutSnapshot): ContentBlock[] {
  const text = snapshot.text.trim()
  return textBlocks(snapshot.truncated ? `${text}${truncationMarker()}` : text)
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
  if (request.signal.aborted) {
    throw new Error('subagent-oc: request was aborted before OpenCode startup')
  }
  const texts = textTask(request.prompt)
  const task = texts.join('\n')

  let child: SubprocessHandle
  try {
    child = spec.spawn({
      argv: ocRunArgv(spec, task),
      cwd: spec.cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: STDOUT_MAX_BYTES },
        stderr: 'pipe',
      },
      graceMs: spec.disposeGraceMs,
      env: spec.env,
    })
  } catch (error: unknown) {
    throw ocStartupFailure(error)
  }

  // Child stderr is an observation sink for the Host: forwarded live so the
  // operator can see product errors, and never surfaced into the settled
  // diagnostic (which stays safe by construction).
  const onStderr = (chunk: Buffer | string): void => {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
    try {
      // Synchronous fd forwarding preserves byte order without owning a
      // backpressure queue. A slow host sink can block this event-loop turn.
      writeFileSync(process.stderr.fd, bytes)
    } catch {
      // Host stderr is an observation sink, not a child-run failure authority.
    }
  }
  const onStderrError = (): void => {
    // Stderr observation is auxiliary; done remains the terminal authority.
  }
  child.stderr?.on('data', onStderr)
  child.stderr?.on('error', onStderrError)

  const runAbort = new AbortController()
  const requestCancel = (): void => {
    if (runAbort.signal.aborted) return
    runAbort.abort(new Error('subagent-oc: run cancelled locally'))
    child.terminate()
  }
  const onAbort = (): void => { requestCancel() }
  request.signal.addEventListener('abort', onAbort, { once: true })

  const collectOutput = (): ContentBlock[] => finalOutput(snapshotStdout(child))
  let diagnostic: string | undefined
  const recordDiagnostic = (facts: OcFailureFacts): string => {
    diagnostic = failureDiagnostic(facts)
    return diagnostic
  }

  const result: Promise<SubagentResult> = settleRunResult({
    attempt: async () => {
      let outcome: SubprocessOutcome
      try {
        outcome = await child.done
      } catch (error: unknown) {
        // Every failure path keeps the safe facts in the diagnostic.
        recordDiagnostic({ stage: 'process' })
        throw new OcRunFailure({ stage: 'process' }, thrown(error))
      }
      const output = finalOutput(snapshotStdout(child))
      if (outcome.exitCode === 0) {
        return { output, stopReason: 'completed' }
      }
      recordDiagnostic({ stage: 'process', outcome })
      return { output, diagnostic, stopReason: 'error' }
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
    // Let stderr already queued by the process close reach the Host before
    // its forwarding listeners are detached.
    await new Promise<void>((resolve) => { setImmediate(resolve) })
    child.stderr?.off('data', onStderr)
    child.stderr?.off('error', onStderrError)
  }

  return subprocessRunHandle({
    // The seam brands run ids through dsh-brand's brandString; that helper is
    // skipped here to avoid adding a profile dependency (dsh-brand is not in
    // the web profile closure). The cast is a deliberate local stand-in.
    id: randomUUID() as SessionId,
    result,
    signal: request.signal,
    onAbort,
    requestCancel,
    teardown: disposeProcess,
  })
}