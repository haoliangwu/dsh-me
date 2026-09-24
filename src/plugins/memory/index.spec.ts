/**
 * dsh-memory host tests: the entry contract (name/inject/Config), the pre-step
 * injection handler (append / replace / no-op / empty-block / fault
 * isolation), the event harvest into the real sqlite store (idempotent,
 * supersession chain, disposal cleanup), and the three tools. The cordis
 * context is mocked structurally while the store is a real DatabaseSync
 * under a temp DSH_HOME, so nothing touches the user's home. The live session
 * is a fake whose surface/node list, event log, and append spy drive the
 * pre-step scan exactly like the harness's live Session.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, Config, inject, name, type PreStepDecisionLike, type PreStepPayloadLike } from './index.ts'
import { digestOf, MEMORY_HEADER_LINE } from './pure.ts'

/** One logged event of the fake session (the fields the scan and harvest read). */
interface FakeEvent {
  readonly type: string
  readonly data?: unknown
}

/**
 * A fake live session: seq-indexed log (`snapshotEvents`), surface nodes =
 * every logged event, an append spy that records the payload and pushes the
 * event (mirroring how the harness loop persists decision messages and how
 * the replace path splices).
 */
interface FakeSession {
  readonly id: string
  readonly header: { readonly cwd: string }
  readonly surface: { nodes: number[] }
  events: FakeEvent[]
  appends: Array<{ readonly type: string; readonly data: unknown; readonly opts: unknown }>
  snapshotEvents(): readonly FakeEvent[]
  append: (type: string, data: unknown, opts: unknown) => { seq: number }
}

/** Build a fake session with a spy append seam. */
function fakeSession(cwd = '/work/a', id = 's1', seed: FakeEvent[] = []): FakeSession {
  const events: FakeEvent[] = [...seed]
  const appends: FakeSession['appends'] = []
  const session = {
    id,
    header: { cwd },
    surface: { nodes: [] as number[] },
    events,
    appends,
    snapshotEvents: () => events,
    append: (type: string, data: unknown, opts: unknown) => {
      const seq = events.length
      events.push({ type, data })
      // Mirrors the fold: a tail append adds the node; every test append is a
      // tail append, so nodes stay index == seq.
      session.surface.nodes = events.map((_, index) => index)
      appends.push({ type, data, opts })
      return { seq }
    },
  }
  session.surface.nodes = events.map((_, index) => index)
  return session
}

/** One surfaced dsh-memory context row, as the harness would have persisted it. */
function memoryRow(text: string): FakeEvent {
  return {
    type: 'user/message',
    data: {
      source: { kind: 'plugin', plugin: 'dsh-memory', digest: digestOf(text) },
      content: [{ type: 'text', text }],
    },
  }
}

/** The exact rendered text of one injected memory message (header + block). */
function messageText(block: string): string {
  return `${MEMORY_HEADER_LINE}\n\n${block}`
}

/** Persist one injected memory message onto a fake session, like the loop's user/message append. */
function persistMemoryRow(session: FakeSession, message: UserMessage): void {
  session.append('user/message', message, { surfaceOp: 'append' })
}

interface CheckpointEvent { readonly seq: number; readonly time: number; readonly type: string; readonly data?: unknown; readonly sourceEventSeqs?: unknown }

const SUMMARY_TEXT = '## Primary Request and Intent\n- ship the plugin\n\n## Key Technical Concepts\n- node:sqlite\n\n## Next Step\n- drop me'

/** A polluted checkpoint summary: the compaction preserved a verbatim FENCED echo of an earlier full memory block inside a persistent section. */
const POLLUTED_SUMMARY = [
  '## Primary Request and Intent',
  '- ship the feature',
  '',
  '## Critical Context',
  '- remember the earlier plan:',
  '```',
  '## Project Memory',
  'Knowledge from previous sessions. May be stale; correct via memory_write.',
  '',
  '<project-memory>',
  '<note id="1" scope="global">old fact</note>',
  '</project-memory>',
  '```',
].join('\n')

const CHECKPOINT_PREAMBLE = 'This is an automatically generated compaction checkpoint.'

/** A real checkpoint user/message event: compact source, framed content, sourceEventSeqs. */
function checkpointEvent(seq: number, sourceEventSeqs: number[], summary: string): CheckpointEvent {
  return {
    seq,
    time: seq * 1000,
    type: 'user/message',
    sourceEventSeqs,
    data: {
      source: { kind: 'plugin', plugin: 'compact', compactionId: `c-${seq}` },
      content: [
        { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n<compacted-summary>` },
        { type: 'text', text: summary },
        { type: 'text', text: '</compacted-summary>' },
      ],
    },
  }
}

/** The metadata-only compaction/summary event: must never be harvested. */
function summaryOnlyEvent(seq: number, shadowedSeqs: number[], summary: string): CheckpointEvent {
  return { seq, time: seq * 1000, type: 'compaction/summary', data: { summary: [{ type: 'text', text: summary }], shadowedSeqs } }
}

/** The canonical downstream pre-step decision (claimed message + runtime context, before memory). */
const CLAIMED: UserMessage = {
  id: MessageId('u-claim'),
  role: 'user',
  content: [{ type: 'text', text: 'hello' }],
  source: { kind: 'user' },
}

/** A downstream decision of the kind the harness fallback produces (`kind: 'enter'`). */
function downstreamDecision(messages: readonly UserMessage[] = [CLAIMED]): PreStepDecisionLike {
  return { kind: 'enter', messages: [...messages] }
}

interface Mounted {
  ctx: Record<string, unknown>
  fire: (event: string, ...args: unknown[]) => Promise<void> | void
  tools: Array<{ name: string; execute: (args: never, exec: never) => Promise<unknown>; output: { render: (args: never, value: never) => Array<{ type: string; text: string }> } }>
  executes: (toolName: string, args: unknown, exec: unknown) => Promise<unknown>
  dispose: (session: { id: string; header: { cwd?: string } }) => void
  prestep: (session: FakeSession, next?: () => Promise<PreStepDecisionLike>) => Promise<PreStepDecisionLike>
  warnSpy: ReturnType<typeof vi.fn>
  /** Prefix routes captured from the fake webServer (the Memory tab channel). */
  routes: Array<{ kind: string; path: string; handler: (req: unknown, res: unknown) => void }>
}

/** Boot apply over a structurally-mocked cordis context and capture every seam. */
function mount(config: Record<string, unknown> = {}): Mounted {
  const listeners: Record<string, Array<(...args: unknown[]) => unknown>> = {}
  const tools: Mounted['tools'] = []
  const warnSpy = vi.fn()
  const routes: Mounted['routes'] = []
  const ctx = {
    logger: { warn: warnSpy, info: vi.fn() },
    on: vi.fn((event: string, listener: (...args: unknown[]) => unknown) => {
      (listeners[event] ??= []).push(listener)
      return () => {}
    }),
    effect: vi.fn((fn: () => unknown) => fn()),
    tools: {
      register: (def: unknown) => { tools.push(def as Mounted['tools'][number]); return () => {} },
    },
    webServer: {
      register: (route: { kind: string; path: string; handler: (req: unknown, res: unknown) => void }) => {
        routes.push(route)
        return () => { routes.splice(routes.indexOf(route), 1) }
      },
    },
  }
  apply(ctx as never, Config(config) as never)
  return {
    ctx,
    fire: (event, ...args) => {
      const results = (listeners[event] ?? []).map(listener => listener(...args))
      const pending = results.filter((result): result is Promise<unknown> => result instanceof Promise)
      return pending.length > 0 ? Promise.all(pending).then(() => undefined) : undefined
    },
    tools,
    executes: async (toolName, args, exec) => {
      const tool = tools.find(candidate => candidate.name === toolName)
      if (tool === undefined) throw new Error(`tool ${toolName} not registered`)
      return tool.execute(args as never, exec as never)
    },
    dispose: (session) => { for (const listener of listeners['session/disposed'] ?? []) listener(session) },
    prestep: (session, next = () => Promise.resolve(downstreamDecision())) =>
      Promise.resolve((listeners['agent/pre-step']?.[0] as (payload: PreStepPayloadLike, n: () => Promise<PreStepDecisionLike>) => Promise<PreStepDecisionLike> | undefined)?.(
        { agent: { session: session as unknown as import('./index.ts').LiveSessionLike } },
        next,
      ) ?? downstreamDecision()),
    warnSpy,
    routes,
  }
}

/** Run one pre-step and pull the injected memory message out of the decision, if any. */
function injectedMemoryMessage(decision: PreStepDecisionLike): UserMessage | undefined {
  if (decision.kind !== 'enter') return undefined
  return decision.messages.find(message =>
    (message.source as { kind?: string; plugin?: string }).kind === 'plugin'
    && (message.source as { plugin?: string }).plugin === 'dsh-memory')
}

/** The non-memory messages of an enter decision (the downstream claim batch). */
function downstreamMessages(decision: PreStepDecisionLike): readonly UserMessage[] {
  if (decision.kind !== 'enter') return []
  return decision.messages.filter(message =>
    !((message.source as { kind?: string; plugin?: string }).kind === 'plugin'
      && (message.source as { plugin?: string }).plugin === 'dsh-memory'))
}

describe('plugin contract', () => {
  it('declares the id, the tools + webServer injection, and the dual-pool config', () => {
    expect(name).toBe('dsh-memory')
    expect(inject).toEqual(['tools', 'webServer'])
    expect(Config({})).toEqual({ maxEntryChars: 2500, maxCompactionSummaries: 2, maxManualEntries: 10 })
    expect(Config({ maxEntryChars: 9000 })).toEqual({
      maxEntryChars: 9000,
      maxCompactionSummaries: 2,
      maxManualEntries: 10,
    })
    expect(() => Config({ maxEntryChars: 0 })).toThrow()
    expect(() => Config({ maxCompactionSummaries: -1 })).toThrow()
  })
})

describe('pre-step injection (agent/pre-step)', () => {
  beforeEach(() => {
    process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-memory-test-'))
  })
  afterEach(() => {
    if (process.env.DSH_HOME !== undefined) rmSync(process.env.DSH_HOME, { recursive: true, force: true })
    delete process.env.DSH_HOME
  })

  it('appends one plugin-sourced user message with a digest on a fresh session with a non-empty block', async () => {
    const mounted = mount()
    const session = fakeSession()
    const sibling = fakeSession('/work/a', 's2')
    await mounted.fire('session/event', sibling, checkpointEvent(10, [1, 2, 3], SUMMARY_TEXT))
    const decision = await mounted.prestep(session)
    const memory = injectedMemoryMessage(decision)
    expect(memory).toBeDefined()
    expect(memory?.role).toBe('user')
    expect((memory?.content[0] as { text: string }).text).toContain('Persisted cross-session memory:')
    expect((memory?.content[0] as { text: string }).text).toContain('## Project Memory')
    expect((memory?.content[0] as { text: string }).text).toContain('- ship the plugin')
    const source = memory?.source as { kind: string; plugin: string; digest: string }
    expect(source.kind).toBe('plugin')
    expect(source.plugin).toBe('dsh-memory')
    expect(source.digest).toMatch(/^[0-9a-f]{64}$/)
    // No in-place replace on the fresh path; the message rides the decision.
    expect(session.appends).toEqual([])
  })

  it('keeps the downstream messages (the actual user prompt) intact alongside the memory message', async () => {
    const mounted = mount()
    const session = fakeSession()
    const sibling = fakeSession('/work/a', 's2')
    await mounted.fire('session/event', sibling, checkpointEvent(10, [1], SUMMARY_TEXT))
    const decision = await mounted.prestep(session)
    expect(downstreamMessages(decision)).toHaveLength(1)
    expect(downstreamMessages(decision)[0]?.id).toBe('u-claim')
  })

  it('does nothing when the surfaced row carries the same digest (byte-stable no-op)', async () => {
    const mounted = mount()
    const session = fakeSession()
    const sibling = fakeSession('/work/a', 's2')
    await mounted.fire('session/event', sibling, checkpointEvent(10, [1], SUMMARY_TEXT))
    const first = await mounted.prestep(session)
    const memory = injectedMemoryMessage(first)
    expect(memory).toBeDefined()
    // The harness persisted the decision message as a surface row; mirror that.
    if (memory !== undefined) persistMemoryRow(session, memory)
    // Second pre-step with an unchanged store: the row is byte-stable, the
    // digest matches, nothing is appended or replaced.
    const second = await mounted.prestep(session)
    expect(injectedMemoryMessage(second)).toBeUndefined()
    expect(session.appends).toHaveLength(1)
  })

  it('replaces the stale row in place with the fresh content and digest, without enter messages', async () => {
    const mounted = mount()
    const oldBlock = '## Project Memory\n<project-memory>\n<note id="1" scope="workspace">old fact</note>\n</project-memory>'
    const session = fakeSession('/work/a', 's1', [memoryRow(messageText(oldBlock))])
    await mounted.executes('memory_write', { content: 'new fact' }, { agent: { id: 's1', session } })
    const decision = await mounted.prestep(session)
    // No enter-message injection: the replace path persists the row directly.
    expect(injectedMemoryMessage(decision)).toBeUndefined()
    expect(downstreamMessages(decision)).toHaveLength(1)
    expect(session.appends).toHaveLength(1)
    const append = session.appends[0]
    expect(append?.type).toBe('user/message')
    const opts = append?.opts as { surfaceOp: { op: string; startSeq: number; endSeq: number }; sourceEventSeqs: number[] }
    expect(opts.surfaceOp).toEqual({ op: 'replace', startSeq: 0, endSeq: 0 })
    expect(opts.sourceEventSeqs).toEqual([0])
    const data = append?.data as UserMessage
    expect((data.content[0] as { text: string }).text).toContain('new fact')
    expect((data.source as unknown as { digest: string }).digest).not.toBe(digestOf(messageText(oldBlock)))
  })

  it('never injects when the assembled block is empty', async () => {
    const mounted = mount()
    const session = fakeSession()
    const decision = await mounted.prestep(session)
    expect(injectedMemoryMessage(decision)).toBeUndefined()
    expect(session.appends).toEqual([])
    expect(downstreamMessages(decision)).toHaveLength(1)
  })

  it('takes effect between steps: a store write after a fresh append replaces the row on the next pre-step', async () => {
    const mounted = mount()
    const session = fakeSession()
    const sibling = fakeSession('/work/a', 's2')
    // Step 1: no row yet → the decision carries the memory message.
    await mounted.fire('session/event', sibling, checkpointEvent(10, [1], SUMMARY_TEXT))
    const first = await mounted.prestep(session)
    const firstMemory = injectedMemoryMessage(first)
    expect(firstMemory).toBeDefined()
    // The harness persists decision messages as surface rows; mirror that.
    if (firstMemory !== undefined) persistMemoryRow(session, firstMemory)
    expect(session.appends).toHaveLength(1)
    // Store write between steps (takes effect immediately: next pre-step).
    await mounted.executes('memory_write', { content: 'fresh workspace fact' }, { agent: { id: 's1', session } })
    // Step 2: the surfaced row's digest is stale → in-place replace, no new enter message.
    const second = await mounted.prestep(session)
    expect(injectedMemoryMessage(second)).toBeUndefined()
    expect(session.appends).toHaveLength(2)
    const append = session.appends[1]
    const opts = append?.opts as { surfaceOp: { op: string; startSeq: number; endSeq: number }; sourceEventSeqs: number[] }
    expect(opts.surfaceOp).toEqual({ op: 'replace', startSeq: 0, endSeq: 0 })
  })

  it('swallows internal handler failures: the waterfall still runs and the decision returns', async () => {
    const mounted = mount()
    const session = fakeSession()
    const sibling = fakeSession('/work/a', 's2')
    await mounted.fire('session/event', sibling, checkpointEvent(10, [1], SUMMARY_TEXT))
    // A broken log read (or a store fault — same try block) must never break the waterfall.
    session.snapshotEvents = () => { throw new Error('log read failed') }
    const decision = await mounted.prestep(session)
    expect(decision).toEqual(downstreamDecision())
    expect(injectedMemoryMessage(decision)).toBeUndefined()
    expect(mounted.warnSpy).toHaveBeenCalledWith(expect.stringContaining('[dsh-memory] injection failed'))
  })

  it('does nothing when the session carries no cwd (nothing to scope into)', async () => {
    const mounted = mount()
    const noCwd = { ...fakeSession(), header: {} } as unknown as FakeSession
    const decision = await mounted.prestep(noCwd)
    expect(injectedMemoryMessage(decision)).toBeUndefined()
  })

  it('returns a rejected downstream decision untouched (never overrides the harness)', async () => {
    const mounted = mount()
    const session = fakeSession()
    const sibling = fakeSession('/work/a', 's2')
    await mounted.fire('session/event', sibling, checkpointEvent(10, [1], SUMMARY_TEXT))
    const decision = await mounted.prestep(session, () => Promise.resolve({ kind: 'reject' }))
    expect(decision).toEqual({ kind: 'reject' })
  })
})

describe('compaction harvest (session/event → next injection)', () => {
  beforeEach(() => {
    process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-memory-test-'))
  })
  afterEach(() => {
    if (process.env.DSH_HOME !== undefined) rmSync(process.env.DSH_HOME, { recursive: true, force: true })
    delete process.env.DSH_HOME
  })

  it('stores a compaction checkpoint into the injected block, filtered to persistent sections', async () => {
    const mounted = mount()
    const session = fakeSession()
    const sibling = fakeSession('/work/a', 's2')
    await mounted.fire('session/event', sibling, checkpointEvent(10, [1, 2, 3], SUMMARY_TEXT))
    const decision = await mounted.prestep(session)
    const text = (injectedMemoryMessage(decision)?.content[0] as { text: string }).text
    expect(text).toContain('## Project Memory')
    expect(text).toContain('<checkpoint id="1"')
    expect(text).toContain('- ship the plugin')
    expect(text).not.toContain('- drop me')
  })

  it('strips a nested memory-block echo out of the rendered block (the store keeps the raw segment)', async () => {
    const mounted = mount()
    const session = fakeSession()
    const sibling = fakeSession('/work/a', 's2')
    await mounted.fire('session/event', sibling, checkpointEvent(10, [1, 2, 3], POLLUTED_SUMMARY))
    const decision = await mounted.prestep(session)
    const text = (injectedMemoryMessage(decision)?.content[0] as { text: string }).text
    // Real checkpoint content survives; the fenced echo of the whole prior
    // block (guidance line, wrapper, note body) is gone. The only remaining
    // `## Project Memory` is the block's own fixed header.
    expect(text).toContain('- remember the earlier plan:')
    expect(text).not.toContain('old fact')
    expect(text.match(/## Project Memory/g)).toHaveLength(1)
    expect(text.match(/<project-memory>/g)).toHaveLength(1)
  })

  it('does not harvest a compaction/summary-shaped event without a checkpoint user/message', async () => {
    const mounted = mount()
    const session = fakeSession()
    await mounted.fire('session/event', session, summaryOnlyEvent(10, [1, 2, 3], SUMMARY_TEXT))
    const decision = await mounted.prestep(session)
    expect(injectedMemoryMessage(decision)).toBeUndefined()
  })

  it('does not harvest a user/message whose source is not a compact checkpoint', async () => {
    const mounted = mount()
    const session = fakeSession()
    await mounted.fire('session/event', session, {
      seq: 10, time: 10_000, type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'plain message' }] },
    })
    const decision = await mounted.prestep(session)
    expect(injectedMemoryMessage(decision)).toBeUndefined()
  })

  it('is idempotent: replaying the same event stores nothing new', async () => {
    const mounted = mount()
    const session = fakeSession()
    const sibling = fakeSession('/work/a', 's2')
    await mounted.fire('session/event', sibling, checkpointEvent(10, [1, 2, 3], SUMMARY_TEXT))
    await mounted.fire('session/event', sibling, checkpointEvent(10, [1, 2, 3], SUMMARY_TEXT))
    const decision = await mounted.prestep(session)
    const text = (injectedMemoryMessage(decision)?.content[0] as { text: string }).text
    expect(text.match(/<checkpoint/g)).toHaveLength(1)
  })

  it('marks the older checkpoint superseded when a later compaction shadows its surface seq', async () => {
    const mounted = mount()
    const session = fakeSession()
    const sibling = fakeSession('/work/a', 's2')
    await mounted.fire('session/event', sibling, checkpointEvent(5, [1, 3, 2, 4], '## Primary Request and Intent\n- first checkpoint'))
    await mounted.fire('session/event', sibling, checkpointEvent(9, [5, 8, 6, 7, 5], '## Primary Request and Intent\n- consolidated checkpoint'))
    const decision = await mounted.prestep(session)
    const text = (injectedMemoryMessage(decision)?.content[0] as { text: string }).text
    expect(text).toContain('- consolidated checkpoint')
    expect(text).not.toContain('- first checkpoint')
    expect(text.match(/<checkpoint/g)).toHaveLength(1)
  })

  it('keeps checkpoints of sibling sessions in the same workspace visible', async () => {
    const mounted = mount()
    const other = fakeSession('/work/a', 's2')
    const session = fakeSession('/work/a', 's1')
    await mounted.fire('session/event', other, checkpointEvent(10, [1], SUMMARY_TEXT))
    const decision = await mounted.prestep(session)
    const text = (injectedMemoryMessage(decision)?.content[0] as { text: string }).text
    expect(text).toContain('- ship the plugin')
  })

  it('never injects the session\'s own fresh compaction summary (post-compact self-duplication rule)', async () => {
    const mounted = mount()
    const session = fakeSession('/work/a', 's1')
    await mounted.fire('session/event', session, checkpointEvent(10, [1, 2, 3], SUMMARY_TEXT))
    const decision = await mounted.prestep(session)
    // The replacement row is still on S's own surface — the assembled block is
    // empty after the exclusion, so the never-inject path applies.
    expect(injectedMemoryMessage(decision)).toBeUndefined()
    expect(session.appends).toEqual([])
  })

  it('drops the oldest checkpoint group under maxCompactionSummaries (whole-group admission)', async () => {
    const mounted = mount({ maxCompactionSummaries: 1 })
    const session = fakeSession()
    const sibling = fakeSession('/work/a', 's2')
    await mounted.fire('session/event', sibling, checkpointEvent(10, [1], SUMMARY_TEXT))
    await mounted.fire('session/event', sibling, checkpointEvent(20, [11], '## Primary Request and Intent\n- newer checkpoint content'))
    const decision = await mounted.prestep(session)
    const text = (injectedMemoryMessage(decision)?.content[0] as { text: string }).text
    expect(text).toContain('- newer checkpoint content')
    expect(text).not.toContain('- ship the plugin')
    expect(text).toContain('(1 older memories omitted)')
  })

  it('drops the oldest manual entries over maxManualEntries without touching the compaction pool', async () => {
    const mounted = mount({ maxManualEntries: 1 })
    const session = fakeSession()
    await mounted.executes('memory_write', { content: 'first note' }, { agent: { id: 's1', session } })
    await mounted.executes('memory_write', { content: 'second note' }, { agent: { id: 's1', session } })
    const sibling = fakeSession('/work/a', 's2')
    await mounted.fire('session/event', sibling, checkpointEvent(10, [1], SUMMARY_TEXT))
    const decision = await mounted.prestep(session)
    const text = (injectedMemoryMessage(decision)?.content[0] as { text: string }).text
    expect(text).toContain('second note')
    expect(text).not.toContain('first note')
    expect(text).toContain('- ship the plugin')
    expect(text).toContain('(1 older memories omitted)')
  })

  it('segments a long summary end-to-end: cont markers in the injected block, digest stable across unchanged steps', async () => {
    const mounted = mount()
    const session = fakeSession()
    const bullets = Array.from({ length: 10 }, () => `- ${'x'.repeat(298)}`)
    const longSummary = `## Files and Code\n${bullets.join('\n')}\n\n## Key Technical Concepts\n- node:sqlite`
    const sibling = fakeSession('/work/a', 's2')
    await mounted.fire('session/event', sibling, checkpointEvent(10, [1], longSummary))
    const first = await mounted.prestep(session)
    const memory = injectedMemoryMessage(first)
    expect(memory).toBeDefined()
    const text = (memory?.content[0] as { text: string }).text
    // The oversized Files section split into 2 chunks (8 + 2 bullets at the
    // default cap), each carrying its cont marker; the small section stayed whole.
    expect(text).toContain('## Files and Code (cont. 1/2)')
    expect(text).toContain('## Files and Code (cont. 2/2)')
    expect(text).toContain('## Key Technical Concepts')
    expect(text.match(/<checkpoint/g)).toHaveLength(1)
    // Digest stability: the same store renders the same bytes → no-op.
    if (memory !== undefined) persistMemoryRow(session, memory)
    const second = await mounted.prestep(session)
    expect(injectedMemoryMessage(second)).toBeUndefined()
    expect(session.appends).toHaveLength(1)
  })
})

describe('session disposal cleanup', () => {
  beforeEach(() => {
    process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-memory-test-'))
  })
  afterEach(() => {
    if (process.env.DSH_HOME !== undefined) rmSync(process.env.DSH_HOME, { recursive: true, force: true })
    delete process.env.DSH_HOME
  })

  it('drops that session\'s notes but keeps its workspace checkpoints', async () => {
    const mounted = mount()
    const session = fakeSession('/work/a', 's1')
    const sibling = fakeSession('/work/a', 's2')
    await mounted.fire('session/event', sibling, checkpointEvent(10, [1], SUMMARY_TEXT))
    await mounted.executes('memory_write', { content: 'a session note', scope: 'session' }, { agent: { id: 's1', session } })
    const decision = await mounted.prestep(session)
    expect((injectedMemoryMessage(decision)?.content[0] as { text: string }).text).toContain('a session note')
    mounted.dispose(session)
    const after = await mounted.prestep(session)
    const text = (injectedMemoryMessage(after)?.content[0] as { text: string }).text
    expect(text).not.toContain('a session note')
    expect(text).toContain('- ship the plugin')
  })
})

describe('tools', () => {
  beforeEach(() => {
    process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-memory-test-'))
  })
  afterEach(() => {
    if (process.env.DSH_HOME !== undefined) rmSync(process.env.DSH_HOME, { recursive: true, force: true })
    delete process.env.DSH_HOME
  })

  it('registers memory_write, memory_list, and memory_forget', () => {
    const mounted = mount()
    expect(mounted.tools.map(tool => tool.name)).toEqual(['memory_write', 'memory_list', 'memory_forget'])
  })

  it('memory_write stores a note visible on the next pre-step injection', async () => {
    const mounted = mount()
    const session = fakeSession()
    const written = await mounted.executes('memory_write', { content: 'user prefers terse replies', scope: 'global' }, { agent: { id: 's1', session } })
    expect(written).toEqual({ id: 1, scope: 'global' })
    const decision = await mounted.prestep(session)
    const text = (injectedMemoryMessage(decision)?.content[0] as { text: string }).text
    expect(text).toContain('<note id="1" scope="global">user prefers terse replies</note>')
  })

  it('memory_write defaults to the workspace scope and rejects empty content', async () => {
    const mounted = mount()
    const session = fakeSession()
    const written = await mounted.executes('memory_write', { content: 'workspace fact' }, { agent: { id: 's1', session } })
    expect(written).toEqual({ id: 1, scope: 'workspace' })
    await expect(mounted.executes('memory_write', { content: '   ' }, { agent: { id: 's1', session } })).rejects.toThrow()
  })

  it('memory_write truncates content over maxEntryChars at write time with the segment marker', async () => {
    const mounted = mount({ maxEntryChars: 200 })
    const session = fakeSession()
    const written = await mounted.executes('memory_write', { content: 'x'.repeat(500) }, { agent: { id: 's1', session } })
    expect(written).toEqual({ id: 1, scope: 'workspace' })
    const listed = await mounted.executes('memory_list', {}, { agent: { id: 's1', session } })
    const content = (listed as { memories: Array<{ content: string }> }).memories[0]?.content
    expect(content).toContain('[segment truncated: 364 chars omitted]')
    expect(content?.length).toBeLessThanOrEqual(200)
    expect(content).not.toContain('x'.repeat(400))
  })

  it('memory_write session scope fails loudly without session context', async () => {
    const mounted = mount()
    await expect(mounted.executes('memory_write', { content: 'orphan note', scope: 'session' }, { agent: undefined }))
      .rejects.toThrow(/session context/)
  })

  it('memory_write workspace scope fails loudly when the session has no cwd (never stores as global)', async () => {
    const mounted = mount()
    const agent = { id: 'a1', session: { id: 's1' } } // no header.cwd
    await expect(mounted.executes('memory_write', { content: 'no cwd note' }, { agent }))
      .rejects.toThrow(/workspace scope needs the session cwd/)
    const listed = await mounted.executes('memory_list', {}, { agent: { id: 's1', session: fakeSession() } })
    expect((listed as { memories: unknown[] }).memories).toEqual([])
  })

  it('memory_write session note binds to the session id (agent.id may differ): injected and cleaned by that session', async () => {
    const mounted = mount()
    const session = fakeSession('/work/a', 's1')
    const other = fakeSession('/work/a', 's2')
    // A global row keeps the sibling's block non-empty (proving the session
    // note itself is excluded, not the whole injection).
    await mounted.executes('memory_write', { content: 'global fact', scope: 'global' }, { agent: { id: 's1', session } })
    // dsh rebuilds agents on resume/compact: agent.id differs from session.id.
    const rebuilt = { id: 'rebuilt-agent-42', session }
    const written = await mounted.executes('memory_write', { content: 'session-bound note', scope: 'session' }, { agent: rebuilt })
    expect(written).toEqual({ id: 2, scope: 'session' })
    const decision = await mounted.prestep(session)
    expect((injectedMemoryMessage(decision)?.content[0] as { text: string }).text).toContain('session-bound note')
    const otherDecision = await mounted.prestep(other)
    const otherText = (injectedMemoryMessage(otherDecision)?.content[0] as { text: string }).text
    expect(otherText).toContain('global fact')
    expect(otherText).not.toContain('session-bound note')
    mounted.dispose(session)
    const after = await mounted.prestep(session)
    const afterText = (injectedMemoryMessage(after)?.content[0] as { text: string }).text
    expect(afterText).not.toContain('session-bound note')
  })

  it('memory_list returns previewed rows with provenance', async () => {
    const mounted = mount()
    const session = fakeSession()
    await mounted.executes('memory_write', { content: 'alpha fact', scope: 'workspace' }, { agent: { id: 's1', session } })
    const listed = await mounted.executes('memory_list', { keyword: 'alpha' }, { agent: { id: 's1', session } })
    const memories = (listed as { memories: unknown[] }).memories
    expect(memories).toHaveLength(1)
    expect(memories[0]).toMatchObject({ id: 1, scope: 'workspace', kind: 'manual', content: 'alpha fact' })
    const none = await mounted.executes('memory_list', { keyword: 'zzz' }, { agent: { id: 's1', session } })
    expect((none as { memories: unknown[] }).memories).toEqual([])
  })

  it('memory_forget deletes by id and hides it from the next injection', async () => {
    const mounted = mount()
    const session = fakeSession()
    const written = await mounted.executes('memory_write', { content: 'forget me', scope: 'workspace' }, { agent: { id: 's1', session } })
    const id = (written as { id: number }).id
    const before = await mounted.prestep(session)
    expect((injectedMemoryMessage(before)?.content[0] as { text: string }).text).toContain('forget me')
    const result = await mounted.executes('memory_forget', { id }, { agent: { id: 's1', session } })
    expect(result).toEqual({ deleted: true })
    const after = await mounted.prestep(session)
    expect(injectedMemoryMessage(after)).toBeUndefined()
    const missing = await mounted.executes('memory_forget', { id: 999 }, { agent: { id: 's1', session } })
    expect(missing).toEqual({ deleted: false })
  })

  it('list sees harvested checkpoints once stored', async () => {
    const mounted = mount()
    const session = fakeSession()
    await mounted.fire('session/event', session, checkpointEvent(10, [1], SUMMARY_TEXT))
    const listed = await mounted.executes('memory_list', {}, { agent: { id: 's1', session } })
    expect((listed as { memories: Array<{ kind: string }> }).memories[0]?.kind).toBe('compaction')
  })
})

// ── Memory tab data path: the /dsh-memory webServer channel ────────────────
// The fake webServer captures the prefix route so the Connection-RPC envelope
// is exercised against the real serveChannel with fake req/res streams. The
// route handler fire-and-forgets serveChannel (`void`), so every invocation
// flushes the microtask/timer queue before reading the response.

/** Fake IncomingMessage speaking the async-iterable chunk contract serveChannel reads. A Buffer body is yielded raw (malformed-JSON test). */
function reqOf(method: string, url: string, body: unknown, contentType = 'application/json') {
  const json = Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))
  return {
    method,
    url,
    headers: { 'content-type': contentType },
    once: () => {},
    socket: { once: () => {} },
    [Symbol.asyncIterator]: async function* () { yield json },
  } as unknown as import('node:http').IncomingMessage
}

/** Fake ServerResponse capturing status + body. */
function resOf() {
  let status = 0
  let body = ''
  return {
    get statusCode() { return status },
    get body() { return body },
    setHeader: () => {},
    writeHead: (code: number) => { status = code },
    end: (chunk?: unknown) => { body = String(chunk ?? '') },
  } as unknown as import('node:http').ServerResponse & { statusCode: number; body: string }
}

/** Await the fire-and-forget route handler plus its queued continuation. */
async function invoke(handler: (req: unknown, res: unknown) => void, req: unknown, res: unknown): Promise<void> {
  handler(req, res)
  await new Promise((resolve) => { setTimeout(resolve, 0) })
}

/** POST one client-request envelope for endpoint `name` and return the 200 server-response JSON. */
async function askBlock(handler: (req: unknown, res: unknown) => void, name: string, payload: unknown) {
  const res = resOf()
  await invoke(handler,
    reqOf('POST', `/dsh-memory/${name}`, { type: 'client-request', rpcId: 'r1', method: name, payload }),
    res,
  )
  return { res, message: JSON.parse(res.body) as { type: string; rpcId: string; result: { ok: boolean; value?: { block: string }; error?: { code: string; message: string } } } }
}

describe('webServer channel (Memory tab)', () => {
  beforeEach(() => {
    process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-memory-test-'))
  })
  afterEach(() => {
    if (process.env.DSH_HOME !== undefined) rmSync(process.env.DSH_HOME, { recursive: true, force: true })
    delete process.env.DSH_HOME
  })

  it('mounts the /dsh-memory prefix route inside the effect', () => {
    const mounted = mount()
    expect(mounted.routes).toHaveLength(1)
    expect(mounted.routes[0]?.kind).toBe('prefix')
    expect(mounted.routes[0]?.path).toBe('/dsh-memory')
  })

  it('serves the block endpoint byte-identical to what the pre-step injection injects', async () => {
    const mounted = mount()
    const session = fakeSession('/work/a', 's1')
    const sibling = fakeSession('/work/a', 's2')
    await mounted.fire('session/event', sibling, checkpointEvent(10, [1], SUMMARY_TEXT))
    await mounted.executes('memory_write', { content: 'user prefers terse replies', scope: 'global' }, { agent: { id: 's1', session } })
    // The pre-step's rendered row: header + '\n\n' + block — the exact bytes the model sees.
    const decision = await mounted.prestep(session)
    const text = (injectedMemoryMessage(decision)?.content[0] as { text: string }).text
    const injectedBlock = text.slice(MEMORY_HEADER_LINE.length + 2)
    const { res, message } = await askBlock(mounted.routes[0]?.handler as (req: unknown, res: unknown) => void, 'block', { sessionId: 's1', cwd: '/work/a' })
    expect(res.statusCode).toBe(200)
    expect(message.type).toBe('server-response')
    expect(message.rpcId).toBe('r1')
    expect(message.result.ok).toBe(true)
    expect(message.result.value?.block).toBe(injectedBlock)
    expect(message.result.value?.block).toContain('<note id=')
    expect(message.result.value?.block).toContain('- ship the plugin')
  })

  it('serves no nested memory echoes through the block endpoint (same strip as the injection)', async () => {
    const mounted = mount()
    const session = fakeSession('/work/a', 's1')
    const sibling = fakeSession('/work/a', 's2')
    await mounted.fire('session/event', sibling, checkpointEvent(10, [1], POLLUTED_SUMMARY))
    const { res, message } = await askBlock(mounted.routes[0]?.handler as (req: unknown, res: unknown) => void, 'block', { sessionId: 's1', cwd: '/work/a' })
    expect(res.statusCode).toBe(200)
    expect(message.result.ok).toBe(true)
    const block = message.result.value?.block ?? ''
    expect(block).toContain('- remember the earlier plan:')
    expect(block).not.toContain('old fact')
    expect(block.match(/## Project Memory/g)).toHaveLength(1)
    expect(block.match(/<project-memory>/g)).toHaveLength(1)
  })

  it('block endpoint excludes the requesting session\'s own checkpoint but serves siblings\' (same rule as the injection)', async () => {
    const mounted = mount()
    const self = fakeSession('/work/a', 's1')
    await mounted.fire('session/event', self, checkpointEvent(10, [1], SUMMARY_TEXT))
    const sibling = fakeSession('/work/a', 's2')
    await mounted.fire('session/event', sibling, checkpointEvent(20, [11], '## Primary Request and Intent\n- sibling goal'))
    const handler = mounted.routes[0]?.handler as (req: unknown, res: unknown) => void
    // s1's own request: its checkpoint is excluded, the sibling's is served.
    const own = await askBlock(handler, 'block', { sessionId: 's1', cwd: '/work/a' })
    expect(own.message.result.ok).toBe(true)
    expect(own.message.result.value?.block).toContain('- sibling goal')
    expect(own.message.result.value?.block).not.toContain('- ship the plugin')
    // s2's own request: the mirror image — its checkpoint is excluded, s1's is served.
    const other = await askBlock(handler, 'block', { sessionId: 's2', cwd: '/work/a' })
    expect(other.message.result.ok).toBe(true)
    expect(other.message.result.value?.block).toContain('- ship the plugin')
    expect(other.message.result.value?.block).not.toContain('- sibling goal')
  })

  it('answers an empty block for empty sessionId/cwd (and for a missing payload)', async () => {
    const mounted = mount()
    const session = fakeSession('/work/a', 's1')
    await mounted.fire('session/event', session, checkpointEvent(10, [1], SUMMARY_TEXT))
    const handler = mounted.routes[0]?.handler as (req: unknown, res: unknown) => void
    const empty = await askBlock(handler, 'block', { sessionId: '', cwd: '' })
    expect(empty.message.result).toEqual({ ok: true, value: { block: '' } })
    const missing = await askBlock(handler, 'block', {})
    expect(missing.message.result).toEqual({ ok: true, value: { block: '' } })
  })

  it('answers the RPC error shape for an unknown endpoint', async () => {
    const mounted = mount()
    const { res, message } = await askBlock(mounted.routes[0]?.handler as (req: unknown, res: unknown) => void, 'nope', {})
    expect(res.statusCode).toBe(200)
    expect(message.result.ok).toBe(false)
    expect(message.result.error?.code).toBe('internal')
    expect(message.result.error?.message).toContain('unknown endpoint nope')
  })

  it('404s a non-POST request and an unknown endpoint segment', async () => {
    const mounted = mount()
    const handler = mounted.routes[0]?.handler as (req: unknown, res: unknown) => void
    const res = resOf()
    await invoke(handler, reqOf('GET', '/dsh-memory/block', {}), res)
    expect(res.statusCode).toBe(404)
    const res2 = resOf()
    await invoke(handler, reqOf('POST', '/dsh-memory/../etc', {}), res2)
    expect(res2.statusCode).toBe(404)
  })

  it('415s a non-JSON content type, 400s a malformed body, and rejects a mismatched method', async () => {
    const mounted = mount()
    const handler = mounted.routes[0]?.handler as (req: unknown, res: unknown) => void
    const res = resOf()
    await invoke(handler, reqOf('POST', '/dsh-memory/block', {}, 'text/plain'), res)
    expect(res.statusCode).toBe(415)
    const res2 = resOf()
    await invoke(handler, reqOf('POST', '/dsh-memory/block', Buffer.from('not json')), res2)
    expect(res2.statusCode).toBe(400)
    const res3 = resOf()
    await invoke(handler,
      reqOf('POST', '/dsh-memory/block', { type: 'client-request', rpcId: 'r1', method: 'bogus', payload: {} }),
      res3,
    )
    expect(res3.statusCode).toBe(200)
    const message = JSON.parse(res3.body) as { result: { ok: boolean; error?: { code: string } } }
    expect(message.result.ok).toBe(false)
    expect(message.result.error?.code).toBe('gateway/bad-request')
  })
})