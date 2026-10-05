import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from './index.ts'
import { ocRunArgv, resolveOcBinary, textTask } from './run.ts'
import type { SubprocessHandle, SubprocessOutcome, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import type { ResolvedSubagentStartRequest, SubagentRun } from '@deepseek-ai/dsh-subagent'

/** Real enterable workspace for the child cwd (resolveChildCwd asserts it). */
const parentCwd = mkdtempSync(join(tmpdir(), 'subagent-oc-spec-'))
afterAll(() => { rmSync(parentCwd, { recursive: true, force: true }) })

/** Minimal cordis-shaped context double exposing the subagent registry. */
function fakeCtx(binPath: string, spawnImpl?: (spec: SubprocessSpawnSpec) => SubprocessHandle) {
  const registered: unknown[] = []
  const spawn = vi.fn(spawnImpl ?? ((_spec: SubprocessSpawnSpec): never => {
    throw new Error('no spawn impl in this test')
  }))
  const logger = { warn: vi.fn() }
  return {
    subagents: { registerProvider: (provider: unknown) => { registered.push(provider) } },
    subprocess: { spawn },
    logger,
    registered,
    spawn,
  }
}

interface FakeReaderOptions {
  text: () => string
  lossy?: () => boolean
}

function fakeReader(options: FakeReaderOptions) {
  return {
    readFrom: () => ({ text: options.text(), nextOffset: 0, lossy: options.lossy?.() ?? false }),
  }
}

interface FakeHandleOptions {
  outcome?: SubprocessOutcome
  /** When set, `done` rejects with this error immediately. */
  reject?: Error
  stdout?: () => string
  stdoutLossy?: () => boolean
  /** When set, terminate() resolves `done` through the provided fire function. */
  onTerminate?: (fire: () => void) => void
}

function fakeHandle(options: FakeHandleOptions = {}): {
  handle: SubprocessHandle
  terminate: ReturnType<typeof vi.fn>
  waitForExit: ReturnType<typeof vi.fn>
  stderr: EventEmitter
} {
  const stderr = new EventEmitter() as unknown as NonNullable<SubprocessHandle['stderr']>
  let resolveDone: (outcome: SubprocessOutcome) => void = () => {}
  const done = options.reject !== undefined
    ? Promise.reject(options.reject)
    : options.onTerminate === undefined && options.outcome !== undefined
      ? Promise.resolve(options.outcome)
      : new Promise<SubprocessOutcome>((resolve) => { resolveDone = resolve })
  const terminate = vi.fn(() => {
    if (options.onTerminate !== undefined) {
      options.onTerminate(() => { resolveDone({ exitCode: null, signal: 'SIGTERM' }) })
      return
    }
    if (options.outcome !== undefined) resolveDone(options.outcome)
  })
  const waitForExit = vi.fn(async () => true)
  const handle: SubprocessHandle = {
    stdin: undefined,
    stdout: undefined,
    stderr,
    control: undefined,
    collected: {
      stdout: fakeReader({ text: options.stdout ?? (() => ''), lossy: options.stdoutLossy }),
    },
    done,
    terminate,
    waitForExit,
  }
  return { handle, terminate, waitForExit, stderr }
}

function request(overrides: Partial<ResolvedSubagentStartRequest> = {}): ResolvedSubagentStartRequest {
  const controller = new AbortController()
  return {
    prompt: [{ type: 'text', text: 'do the thing' }],
    signal: controller.signal,
    parent: {
      session: {
        header: { cwd: parentCwd },
      },
    },
    descriptor: { sessionId: 'session-child' },
    ...overrides,
  } as unknown as ResolvedSubagentStartRequest
}

describe('ocRunArgv', () => {
  it('builds the fixed standalone command with the default agent', () => {
    expect(ocRunArgv(
      { binPath: '/bin/opencode', model: undefined, agent: 'orchestrator', autoApprove: false, showThinking: false },
      'task text',
    )).toEqual(['/bin/opencode', 'run', '--standalone', '--agent', 'orchestrator', 'task text'])
  })

  it('appends model, auto, and thinking flags when configured', () => {
    expect(ocRunArgv(
      { binPath: 'opencode', model: 'deepseek/deepseek-reasoner', agent: 'build', autoApprove: true, showThinking: true },
      't',
    )).toEqual([
      'opencode', 'run', '--standalone', '--agent', 'build',
      '--model', 'deepseek/deepseek-reasoner', '--auto', '--thinking', 't',
    ])
  })
})

describe('resolveOcBinary', () => {
  it('accepts an existing executable absolute path', () => {
    expect(resolveOcBinary(process.execPath)).toBe(process.execPath)
  })

  it('rejects a non-executable absolute path', () => {
    expect(() => resolveOcBinary('/definitely/missing/opencode')).toThrow(/binPath/)
  })

  it('finds a bare name on PATH', () => {
    const dir = process.execPath.slice(0, process.execPath.lastIndexOf('/'))
    expect(resolveOcBinary(process.execPath.slice(process.execPath.lastIndexOf('/') + 1), dir))
      .toBe(process.execPath)
  })

  it('fails loud when the name is nowhere on PATH', () => {
    expect(() => resolveOcBinary('opencode', '/definitely/missing')).toThrow(/cannot resolve/)
  })
})

describe('textTask', () => {
  it('rejects non-text blocks', () => {
    expect(() => textTask([{ type: 'tool', id: 'x' } as never])).toThrow(/only text blocks/)
  })

  it('rejects an empty task', () => {
    expect(() => textTask([{ type: 'text', text: '   ' }])).toThrow(/must not be empty/)
  })
})

describe('apply', () => {
  it('registers the oc provider with default name, capabilities, and binary', () => {
    const ctx = fakeCtx(process.execPath)
    apply(ctx as never, { binPath: process.execPath })
    expect(ctx.registered).toHaveLength(1)
    const provider = ctx.registered[0] as {
      name: string
      capabilities: object
      inheritsParentContext: boolean
    }
    expect(provider.name).toBe('oc')
    expect(provider.capabilities).toEqual({
      agentOptions: false,
      outputSchema: false,
      depthLimit: false,
      toolFilter: false,
      persona: false,
    })
    expect(provider.inheritsParentContext).toBe(false)
  })

  it('fails loud at apply when the binary cannot be resolved', () => {
    const ctx = fakeCtx('opencode')
    expect(() => apply(ctx as never, { binPath: '/missing/opencode' }))
      .toThrow(/binPath/)
  })

  it('rejects a disposeGraceMs over the timer ceiling', () => {
    const ctx = fakeCtx(process.execPath)
    expect(() => apply(ctx as never, { binPath: process.execPath, disposeGraceMs: Number.MAX_SAFE_INTEGER }))
      .toThrow(/no greater than/)
  })

  it('forwards named host env vars into the spawn environment', async () => {
    const name = 'SUBAGENT_OC_TEST_KEY'
    const overrideName = 'SUBAGENT_OC_OVERRIDE'
    const previousName = process.env[name]
    const previousOverride = process.env[overrideName]
    process.env[name] = 'forwarded-value'
    try {
      const { handle } = fakeHandle({ outcome: { exitCode: 0, signal: null } })
      const ctx = fakeCtx(process.execPath, () => handle)
      apply(ctx as never, {
        binPath: process.execPath,
        env: { [overrideName]: 'explicit' },
        envFromProcess: [name, 'SUBAGENT_OC_MISSING_VAR', overrideName],
      })
      process.env[overrideName] = 'from-host'
      const provider = ctx.registered[0] as { start: (r: ResolvedSubagentStartRequest) => Promise<SubagentRun> }
      await provider.start(request())
      const spec = ctx.spawn.mock.calls[0]![0]
      expect(spec.env).toEqual({
        SUBAGENT_OC_TEST_KEY: 'forwarded-value',
        // explicit env wins over a forwarded host value
        SUBAGENT_OC_OVERRIDE: 'explicit',
      })
    } finally {
      if (previousName === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = previousName
      }
      if (previousOverride === undefined) {
        delete process.env[overrideName]
      } else {
        process.env[overrideName] = previousOverride
      }
    }
  })
})

describe('provider run lifecycle', () => {
  function providerWith(spawnImpl: (spec: SubprocessSpawnSpec) => SubprocessHandle) {
    const ctx = fakeCtx(process.execPath, spawnImpl)
    apply(ctx as never, { binPath: process.execPath })
    return {
      provider: ctx.registered[0] as { start: (r: ResolvedSubagentStartRequest) => Promise<SubagentRun> },
      ctx,
    }
  }

  it('spawns opencode run in the parent workspace with the task', async () => {
    const { handle } = fakeHandle({ outcome: { exitCode: 0, signal: null }, stdout: () => 'OK' })
    const { provider, ctx } = providerWith(() => handle)
    const run = await provider.start(request())
    const spec = ctx.spawn.mock.calls[0]![0]
    expect(spec.argv).toEqual([
      process.execPath, 'run', '--standalone', '--agent', 'orchestrator', 'do the thing',
    ])
    expect(spec.cwd).toBe(parentCwd)
    expect(spec.stdio).toEqual({
      stdin: 'ignore',
      stdout: { maxBytes: expect.any(Number) },
      stderr: 'pipe',
    })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.output).toEqual([{ type: 'text', text: 'OK' }])
  })

  it('maps a non-zero exit to an error with a safe facts-only diagnostic', async () => {
    const { handle } = fakeHandle({
      outcome: { exitCode: 7, signal: null },
      stdout: () => 'partial output',
    })
    const { provider, ctx } = providerWith(() => handle)
    const run = await provider.start(request())
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.output).toEqual([{ type: 'text', text: 'partial output' }])
    expect(result.diagnostic).toContain('product: OpenCode')
    expect(result.diagnostic).toContain('exit code: 7')
    // M1: raw stderr must never surface into the settled diagnostic.
    expect(result.diagnostic).not.toContain('boom details')
    // A returned error result does not go through the onError sink.
    expect(ctx.logger.warn).not.toHaveBeenCalled()
  })

  it('settles an error with safe-facts diagnostic when done rejects', async () => {
    const { handle } = fakeHandle({ reject: new Error('transport blew up') })
    const { provider, ctx } = providerWith(() => handle)
    const run = await provider.start(request())
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.diagnostic).toContain('stage: process')
    expect(result.diagnostic).not.toContain('transport blew up')
    expect(ctx.logger.warn).toHaveBeenCalledTimes(1)
  })

  it('appends a truncation marker when the stdout collect tail lost the head', async () => {
    const { handle } = fakeHandle({
      outcome: { exitCode: 0, signal: null },
      stdout: () => 'tail of a very long answer',
      stdoutLossy: () => true,
    })
    const { provider } = providerWith(() => handle)
    const run = await provider.start(request())
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.output[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('tail of a very long answer'),
    })
    expect(result.output[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('[subagent-oc: stdout exceeded 1000000 bytes; head discarded]'),
    })
  })

  it('rejects a start on an aborted request', async () => {
    const { handle } = fakeHandle()
    const { provider } = providerWith(() => handle)
    const controller = new AbortController()
    controller.abort()
    await expect(provider.start(request({ signal: controller.signal })))
      .rejects.toThrow(/aborted before OpenCode/)
  })

  it('rejects a start whose task contains a non-text block', async () => {
    const { handle } = fakeHandle({ outcome: { exitCode: 0, signal: null } })
    const { provider } = providerWith(() => handle)
    const controller = new AbortController()
    await expect(provider.start(request({
      signal: controller.signal,
      prompt: [{ type: 'tool', id: 'nope' } as never],
    }))).rejects.toThrow(/only text blocks/)
  })

  it('rejects a start from a parent session without a workspace', async () => {
    const { handle } = fakeHandle()
    const { provider } = providerWith(() => handle)
    expect(() => provider.start(request({
      parent: { session: { header: {} } },
    } as never))).toThrow(/no working directory/)
  })

  it('wraps a spawn failure behind fixed safe startup facts', async () => {
    const { provider } = providerWith(() => {
      throw new Error('spawn EACCES')
    })
    await expect(provider.start(request())).rejects.toThrow(/stage: initialize/)
  })

  it('terminates the child and settles aborted with the partial output snapshot', async () => {
    let terminateChild: () => void = () => {}
    const { handle, terminate } = fakeHandle({
      stdout: () => 'partial before cancel',
      onTerminate: (fire) => { terminateChild = fire },
    })
    const { provider } = providerWith(() => handle)
    const controller = new AbortController()
    const run = await provider.start(request({ signal: controller.signal }))
    const resultPromise = run.result
    controller.abort()
    // Let the abort listener run before the child reports its death.
    await Promise.resolve()
    terminateChild()
    const result = await resultPromise
    expect(result.stopReason).toBe('aborted')
    expect(result.output).toEqual([{ type: 'text', text: 'partial before cancel' }])
    expect(terminate).toHaveBeenCalledTimes(1)
  })

  it('dispose reaches quiescence and detaches the stderr forwarder', async () => {
    const { handle, terminate, waitForExit, stderr } = fakeHandle({
      outcome: { exitCode: 0, signal: null },
    })
    const { provider } = providerWith(() => handle)
    const run = await provider.start(request())
    await run.result
    await run.dispose()
    expect(terminate).toHaveBeenCalled()
    expect(waitForExit).toHaveBeenCalledTimes(1)
    expect(stderr.listenerCount('data')).toBe(0)
    expect(stderr.listenerCount('error')).toBe(0)
  })

  it('dispose is idempotent and memoized', async () => {
    const { handle, terminate } = fakeHandle({ outcome: { exitCode: 0, signal: null } })
    const { provider } = providerWith(() => handle)
    const run = await provider.start(request())
    await run.result
    const first = run.dispose()
    const second = run.dispose()
    expect(second).toBe(first)
    await first
    // requestCancel + teardown each terminate; a repeated dispose adds nothing.
    expect(terminate).toHaveBeenCalledTimes(2)
  })
})