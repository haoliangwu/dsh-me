import { afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
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

function fakeReader(text: () => string) {
  return { readFrom: () => ({ text: text(), nextOffset: 0, lossy: false }) }
}

interface FakeHandleOptions {
  outcome?: SubprocessOutcome
  stdout?: () => string
  stderr?: () => string
  /** When set, terminate() resolves `done` with this outcome. */
  onTerminate?: (terminate: () => void) => void
}

function fakeHandle(options: FakeHandleOptions = {}): { handle: SubprocessHandle; terminate: ReturnType<typeof vi.fn>; waitForExit: ReturnType<typeof vi.fn> } {
  let resolveDone: (outcome: SubprocessOutcome) => void = () => {}
  const done = new Promise<SubprocessOutcome>((resolve) => { resolveDone = resolve })
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
    stderr: undefined,
    control: undefined,
    collected: {
      stdout: fakeReader(options.stdout ?? (() => '')),
      stderr: fakeReader(options.stderr ?? (() => '')),
    },
    done: options.onTerminate === undefined
      ? (options.outcome !== undefined
          ? Promise.resolve(options.outcome)
          : done)
      : done,
    terminate,
    waitForExit,
  }
  return { handle, terminate, waitForExit }
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
  it('registers the oc provider and resolves the binary', () => {
    const ctx = fakeCtx(process.execPath)
    apply(ctx as never, { binPath: process.execPath })
    expect(ctx.registered).toHaveLength(1)
    const provider = ctx.registered[0] as { capabilities: object; inheritsParentContext: boolean }
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
    const previous = process.env[name]
    process.env[name] = 'forwarded-value'
    try {
      const { handle } = fakeHandle({ outcome: { exitCode: 0, signal: null } })
      const ctx = fakeCtx(process.execPath, () => handle)
      apply(ctx as never, {
        binPath: process.execPath,
        env: { OVERRIDE: 'explicit' },
        envFromProcess: [name, 'SUBAGENT_OC_MISSING_VAR', 'OVERRIDE'],
      })
      process.env.OVERRIDE = 'from-host'
      const provider = ctx.registered[0] as { start: (r: ResolvedSubagentStartRequest) => Promise<SubagentRun> }
      await provider.start(request())
      const spec = ctx.spawn.mock.calls[0]![0]
      expect(spec.env).toEqual({
        SUBAGENT_OC_TEST_KEY: 'forwarded-value',
        // explicit env wins over a forwarded host value
        OVERRIDE: 'explicit',
      })
    } finally {
      if (previous === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = previous
      }
      delete process.env.OVERRIDE
    }
  })
})

describe('provider run lifecycle', () => {
  function providerWith(spawnImpl: (spec: SubprocessSpawnSpec) => SubprocessHandle) {
    const ctx = fakeCtx(process.execPath, spawnImpl)
    apply(ctx as never, { binPath: process.execPath })
    return { provider: ctx.registered[0] as { start: (r: ResolvedSubagentStartRequest) => Promise<SubagentRun> }, ctx }
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
      stderr: { maxBytes: expect.any(Number) },
    })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.output).toEqual([{ type: 'text', text: 'OK' }])
  })

  it('maps a non-zero exit to an error with a safe diagnostic', async () => {
    const { handle } = fakeHandle({
      outcome: { exitCode: 7, signal: null },
      stdout: () => 'partial output',
      stderr: () => 'boom details',
    })
    const { provider } = providerWith(() => handle)
    const run = await provider.start(request())
    const result = await run.result
    expect(result.stopReason).toBe('error')
    expect(result.output).toEqual([{ type: 'text', text: 'partial output' }])
    expect(result.diagnostic).toContain('product: OpenCode')
    expect(result.diagnostic).toContain('exit code: 7')
    expect(result.diagnostic).toContain('boom details')
  })

  it('rejects a start on an aborted request', async () => {
    const { handle } = fakeHandle()
    const { provider } = providerWith(() => handle)
    const controller = new AbortController()
    controller.abort()
    await expect(provider.start(request({ signal: controller.signal })))
      .rejects.toThrow(/aborted before OpenCode/)
  })

  it('terminates the child and settles aborted when the request signal fires', async () => {
    let terminateChild: () => void = () => {}
    const { handle, terminate } = fakeHandle({
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
    expect(terminate).toHaveBeenCalledTimes(1)
  })

  it('joins the run without rejecting when no text blocks match a tool block', async () => {
    const { handle } = fakeHandle({ outcome: { exitCode: 0, signal: null } })
    const { provider } = providerWith(() => handle)
    const controller = new AbortController()
    await expect(provider.start(request({
      signal: controller.signal,
      prompt: [{ type: 'tool', id: 'nope' } as never],
    }))).rejects.toThrow(/only text blocks/)
  })
})