/**
 * dsh-memory host tests: the entry contract (name/inject/Config), the event
 * harvest into the real sqlite store (idempotent, supersession chain, disposal
 * cleanup), the dynamic section's rendered block, and the three tools. The
 * cordis context is mocked structurally (caveman-style) while the store is a
 * real DatabaseSync under a temp DSH_HOME, so nothing touches the user's home.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply, Config, inject, name } from './index.ts'

interface Session { readonly id: string; readonly header: { readonly cwd?: string } }
interface CheckpointEvent { readonly seq: number; readonly time: number; readonly type: string; readonly data?: unknown; readonly sourceEventSeqs?: unknown }

const SESSION: Session = { id: 's1', header: { cwd: '/work/a' } }
const OTHER_SESSION: Session = { id: 's2', header: { cwd: '/work/a' } }

const SUMMARY_TEXT = '## Primary Request and Intent\n- ship the plugin\n\n## Key Technical Concepts\n- node:sqlite\n\n## Next Step\n- drop me'

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

interface Mounted {
  ctx: Record<string, unknown>
  fire: (event: string, ...args: unknown[]) => void
  sections: Array<{ name: string; order: number; text: (assembly: unknown) => string }>
  tools: Array<{ name: string; execute: (args: never, exec: never) => Promise<unknown>; output: { render: (args: never, value: never) => Array<{ type: string; text: string }> } }>
  emits: string[]
  render: (session?: Session) => string
  execute: (toolName: string, args: never, exec: never) => Promise<unknown>
  dispose: (session: Session) => void
}

/** Boot apply over a structurally-mocked cordis context and capture every seam. */
function mount(config: Record<string, unknown> = {}): Mounted {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {}
  const sections: Mounted['sections'] = []
  const tools: Mounted['tools'] = []
  const emits: string[] = []
  const ctx = {
    logger: { warn: vi.fn(), info: vi.fn() },
    emit: vi.fn((event: string) => { emits.push(event) }),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      (listeners[event] ??= []).push(listener)
      return () => {}
    }),
    effect: vi.fn((fn: () => unknown) => fn()),
    systemPrompt: {
      section: (def: Mounted['sections'][number]) => { sections.push(def); return () => {} },
    },
    tools: {
      register: (def: unknown) => { tools.push(def as Mounted['tools'][number]); return () => {} },
    },
  }
  apply(ctx as never, Config(config) as never)
  return {
    ctx,
    fire: (event, ...args) => { for (const listener of listeners[event] ?? []) listener(...args) },
    sections,
    tools,
    emits,
    render: (session = SESSION) =>
      sections[0]?.text({ agent: { session: { id: session.id, header: { cwd: session.header.cwd } } } }) ?? '',
    execute: async (toolName, args, exec) => {
      const tool = tools.find(candidate => candidate.name === toolName)
      if (tool === undefined) throw new Error(`tool ${toolName} not registered`)
      return tool.execute(args as never, exec as never)
    },
    dispose: (session) => { for (const listener of listeners['session/disposed'] ?? []) listener(session) },
  }
}

/** A caller agent for tool execution. */
const AGENT = { id: 's1', session: SESSION }

describe('plugin contract', () => {
  it('declares the id, the strict systemPrompt+tools injection, and the budget config', () => {
    expect(name).toBe('dsh-memory')
    expect(inject).toEqual(['systemPrompt', 'tools'])
    expect(Config({})).toEqual({ maxBlockChars: 6000 })
    expect(Config({ maxBlockChars: 9000 })).toEqual({ maxBlockChars: 9000 })
    expect(() => Config({ maxBlockChars: 0 })).toThrow()
  })
})

describe('compaction harvest (session/event)', () => {
  beforeEach(() => {
    process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-memory-test-'))
  })
  afterEach(() => {
    if (process.env.DSH_HOME !== undefined) rmSync(process.env.DSH_HOME, { recursive: true, force: true })
    delete process.env.DSH_HOME
  })

  it('stores a compaction checkpoint into the section render, filtered to persistent sections', () => {
    const mounted = mount()
    mounted.fire('session/event', SESSION, checkpointEvent(10, [1, 2, 3], SUMMARY_TEXT))
    const output = mounted.render()
    expect(output).toContain('## Project Memory')
    expect(output).toContain('<checkpoint id="1"')
    expect(output).toContain('- ship the plugin')
    expect(output).not.toContain('- drop me')
  })

  it('does not harvest a compaction/summary-shaped event without a checkpoint user/message', () => {
    const mounted = mount()
    mounted.fire('session/event', SESSION, summaryOnlyEvent(10, [1, 2, 3], SUMMARY_TEXT))
    expect(mounted.render()).toBe('')
  })

  it('does not harvest a user/message whose source is not a compact checkpoint', () => {
    const mounted = mount()
    mounted.fire('session/event', SESSION, {
      seq: 10, time: 10_000, type: 'user/message',
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'plain message' }] },
    })
    expect(mounted.render()).toBe('')
  })

  it('is idempotent: replaying the same event stores nothing new', () => {
    const mounted = mount()
    mounted.fire('session/event', SESSION, checkpointEvent(10, [1, 2, 3], SUMMARY_TEXT))
    mounted.fire('session/event', SESSION, checkpointEvent(10, [1, 2, 3], SUMMARY_TEXT))
    const output = mounted.render()
    expect(output.match(/<checkpoint/g)).toHaveLength(1)
  })

  it('marks the older checkpoint superseded when a later compaction shadows its surface seq', () => {
    // Compaction 1 lands the checkpoint at seq 5; its surface node IS seq 5.
    const mounted = mount()
    mounted.fire('session/event', SESSION, checkpointEvent(5, [1, 3, 2, 4], '## Primary Request and Intent\n- first checkpoint'))
    // Compaction 2 shadows seq 5 (the checkpoint replace node) plus the interim chatter.
    mounted.fire('session/event', SESSION, checkpointEvent(9, [5, 8, 6, 7, 5], '## Primary Request and Intent\n- consolidated checkpoint'))
    const output = mounted.render()
    expect(output).toContain('- consolidated checkpoint')
    expect(output).not.toContain('- first checkpoint')
    expect(output.match(/<checkpoint/g)).toHaveLength(1)
  })

  it('keeps checkpoints of sibling sessions in the same workspace visible', () => {
    const mounted = mount()
    mounted.fire('session/event', OTHER_SESSION, checkpointEvent(10, [1], SUMMARY_TEXT))
    expect(mounted.render(OTHER_SESSION)).toContain('- ship the plugin')
    expect(mounted.render()).toContain('- ship the plugin')
  })

  it('renders nothing for an empty store and without a cwd', () => {
    const mounted = mount()
    expect(mounted.render()).toBe('')
    expect(mounted.sections[0]?.text({ agent: { session: { id: 'x' } } })).toBe('')
  })

  it('applies the configured char budget to the injected block', () => {
    const mounted = mount({ maxBlockChars: 400 })
    mounted.fire('session/event', SESSION, checkpointEvent(10, [1], SUMMARY_TEXT))
    mounted.fire('session/event', SESSION, checkpointEvent(20, [11], '## Primary Request and Intent\n- newer checkpoint content'))
    const output = mounted.render()
    expect(output).toContain('- newer checkpoint content')
    expect(output).not.toContain('- ship the plugin')
    expect(output).toContain('(1 older memories omitted)')
  })

  it('emits system-prompt/change after a harvest', () => {
    const mounted = mount()
    mounted.fire('session/event', SESSION, checkpointEvent(10, [1], SUMMARY_TEXT))
    expect(mounted.emits).toContain('system-prompt/change')
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
    mounted.fire('session/event', SESSION, checkpointEvent(10, [1], SUMMARY_TEXT))
    await mounted.execute('memory_write', { content: 'a session note', scope: 'session' }, { agent: AGENT })
    expect(mounted.render()).toContain('a session note')
    mounted.dispose(SESSION)
    const output = mounted.render()
    expect(output).not.toContain('a session note')
    expect(output).toContain('- ship the plugin')
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

  it('memory_write stores a note visible on the next assembly render', async () => {
    const mounted = mount()
    const written = await mounted.execute('memory_write', { content: 'user prefers terse replies', scope: 'global' }, { agent: AGENT })
    expect(written).toEqual({ id: 1, scope: 'global' })
    const output = mounted.render()
    expect(output).toContain('<note id="1" scope="global">user prefers terse replies</note>')
    expect(mounted.emits).toContain('system-prompt/change')
  })

  it('memory_write defaults to the workspace scope and rejects empty content', async () => {
    const mounted = mount()
    const written = await mounted.execute('memory_write', { content: 'workspace fact' }, { agent: AGENT })
    expect(written).toEqual({ id: 1, scope: 'workspace' })
    await expect(mounted.execute('memory_write', { content: '   ' }, { agent: AGENT })).rejects.toThrow()
  })

  it('memory_write session scope fails loudly without session context', async () => {
    const mounted = mount()
    await expect(mounted.execute('memory_write', { content: 'orphan note', scope: 'session' }, { agent: undefined }))
      .rejects.toThrow(/session context/)
  })

  it('memory_write workspace scope fails loudly when the session has no cwd (never stores as global)', async () => {
    const mounted = mount()
    const agent = { id: 'a1', session: { id: 's1' } } // no header.cwd
    await expect(mounted.execute('memory_write', { content: 'no cwd note' }, { agent }))
      .rejects.toThrow(/workspace scope needs the session cwd/)
    const listed = await mounted.execute('memory_list', {}, { agent: AGENT })
    expect((listed as { memories: unknown[] }).memories).toEqual([])
  })

  it('memory_write session note binds to the session id (agent.id may differ): injected and cleaned by that session', async () => {
    const mounted = mount()
    // dsh rebuilds agents on resume/compact: agent.id differs from session.id.
    const rebuilt = { id: 'rebuilt-agent-42', session: SESSION }
    const written = await mounted.execute('memory_write', { content: 'session-bound note', scope: 'session' }, { agent: rebuilt })
    expect(written).toEqual({ id: 1, scope: 'session' })
    expect(mounted.render()).toContain('<note id="1" scope="session">session-bound note</note>')
    expect(mounted.render(OTHER_SESSION)).not.toContain('session-bound note')
    mounted.dispose(SESSION)
    expect(mounted.render()).not.toContain('session-bound note')
  })

  it('memory_list returns previewed rows with provenance', async () => {
    const mounted = mount()
    await mounted.execute('memory_write', { content: 'alpha fact', scope: 'workspace' }, { agent: AGENT })
    const listed = await mounted.execute('memory_list', { keyword: 'alpha' }, { agent: AGENT })
    const memories = (listed as { memories: unknown[] }).memories
    expect(memories).toHaveLength(1)
    expect(memories[0]).toMatchObject({ id: 1, scope: 'workspace', kind: 'manual', content: 'alpha fact' })
    expect((listed as { memories: unknown[] }).memories).toHaveLength(1)
    const none = await mounted.execute('memory_list', { keyword: 'zzz' }, { agent: AGENT })
    expect((none as { memories: unknown[] }).memories).toEqual([])
  })

  it('memory_forget deletes by id and hides it from the render', async () => {
    const mounted = mount()
    const written = await mounted.execute('memory_write', { content: 'forget me', scope: 'workspace' }, { agent: AGENT })
    const id = (written as { id: number }).id
    expect(mounted.render()).toContain('forget me')
    const result = await mounted.execute('memory_forget', { id }, { agent: AGENT })
    expect(result).toEqual({ deleted: true })
    expect(mounted.render()).not.toContain('forget me')
    const missing = await mounted.execute('memory_forget', { id: 999 }, { agent: AGENT })
    expect(missing).toEqual({ deleted: false })
  })

  it('list sees harvested checkpoints once stored', async () => {
    const mounted = mount()
    mounted.fire('session/event', SESSION, checkpointEvent(10, [1], SUMMARY_TEXT))
    const listed = await mounted.execute('memory_list', {}, { agent: AGENT })
    expect((listed as { memories: Array<{ kind: string }> }).memories[0]?.kind).toBe('compaction')
  })
})