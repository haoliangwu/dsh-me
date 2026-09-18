import { describe, expect, it } from 'vitest'
import {
  deliveryCatalog,
  hopOfLastUserMessage,
  nextHop,
  planDelivery,
  relayBody,
  resolveTarget,
  sameWorkspace,
  type DeliveryPlanInput,
  type TargetLike,
} from './decision.ts'

const A: TargetLike = { sessionId: 'sess-a', title: '规划会话' }
const B: TargetLike = { sessionId: 'sess-b', title: '执行会话' }
const C: TargetLike = { sessionId: 'sess-c', title: '执行会话' }
const D: TargetLike = { sessionId: 'sess-d', title: '简报会话' }
const NO_TITLE: TargetLike = { sessionId: 'sess-e', title: undefined }
const CATALOG: readonly TargetLike[] = [A, B, C, D, NO_TITLE]

describe('resolveTarget', () => {
  it('resolves an exact session id', () => {
    expect(resolveTarget('sess-b', A, CATALOG)).toEqual({ kind: 'target', targetId: 'sess-b' })
  })

  it('resolves a unique exact title owned by another session', () => {
    expect(resolveTarget('简报会话', A, CATALOG)).toEqual({ kind: 'target', targetId: 'sess-d' })
  })

  it('rejects the caller by id as self-send', () => {
    expect(resolveTarget('sess-a', A, CATALOG)).toEqual({ kind: 'self' })
  })

  it('rejects a title that resolves only to the caller as self-send', () => {
    const mock: TargetLike = { sessionId: 'sess-m', title: 'Mock' }
    expect(resolveTarget('Mock', mock, [mock, B])).toEqual({ kind: 'self' })
  })

  it('reports ambiguity and lists every title-matching candidate', () => {
    expect(resolveTarget('执行会话', A, CATALOG)).toEqual({ kind: 'ambiguous', candidates: [B, C] })
  })

  it('reports not-found for an unknown id and title', () => {
    expect(resolveTarget('不存在', A, CATALOG)).toEqual({ kind: 'not-found' })
  })

  it('does not match a title that is undefined', () => {
    expect(resolveTarget('sess-e', A, CATALOG)).toEqual({ kind: 'target', targetId: 'sess-e' })
    expect(resolveTarget('undefined', A, CATALOG)).toEqual({ kind: 'not-found' })
  })
})

describe('hopOfLastUserMessage', () => {
  const relay = (hop: number) => ({
    type: 'user/message' as const,
    data: { source: { kind: 'session-messenger', hop } },
  })

  it('reads the hop of the latest relay message', () => {
    expect(hopOfLastUserMessage([relay(3)])).toBe(3)
  })

  it('treats a human message as a chain reset', () => {
    expect(hopOfLastUserMessage([
      relay(4),
      { type: 'user/message', data: { source: { kind: 'user' } } },
    ])).toBeUndefined()
  })

  it('returns undefined for an empty log', () => {
    expect(hopOfLastUserMessage([])).toBeUndefined()
  })

  it('ignores non-message events', () => {
    expect(hopOfLastUserMessage([
      { type: 'turn/start', data: {} },
      relay(2),
    ])).toBe(2)
  })

  it('defensively reads a malformed relay hop as 0', () => {
    expect(hopOfLastUserMessage([{ type: 'user/message', data: { source: { kind: 'session-messenger' } } }])).toBe(0)
    expect(hopOfLastUserMessage([{ type: 'user/message', data: { source: { kind: 'session-messenger', hop: -3 } } }])).toBe(0)
  })
})

describe('nextHop (hop gate arithmetic)', () => {
  it('starts a human chain at 1', () => {
    expect(nextHop(undefined, 5)).toBe(1)
  })

  it('increments a relay chain', () => {
    expect(nextHop(3, 5)).toBe(4)
  })

  it('admits a delivery exactly at maxHops', () => {
    expect(nextHop(4, 5)).toBe(5)
  })

  it('refuses a delivery that would exceed maxHops', () => {
    expect(nextHop(5, 5)).toBeUndefined()
    expect(nextHop(6, 5)).toBeUndefined()
  })
})

describe('sameWorkspace (catalog scope)', () => {
  const sessions = [
    { id: 's1', header: { cwd: '/work/a' } },
    { id: 's2', header: { cwd: '/work/a' } },
    { id: 's3', header: { cwd: '/work/b' } },
    { id: 's4', header: {} },
  ]

  it('keeps the caller and same-cwd sessions, drops other and cwd-less workspaces', () => {
    expect(sameWorkspace(sessions, '/work/a').map(s => s.id)).toEqual(['s1', 's2'])
  })

  it('matches a cwd-less caller only against cwd-less sessions', () => {
    expect(sameWorkspace(sessions, undefined).map(s => s.id)).toEqual(['s4'])
  })

  it('returns nothing for an empty list', () => {
    expect(sameWorkspace([], '/work/a')).toEqual([])
  })
})

describe('deliveryCatalog (list_sessions rows)', () => {
  it('carries sessionId, title, and status for every entry', () => {
    expect(deliveryCatalog([
      { sessionId: 's1', title: '规划会话', running: true },
      { sessionId: 's2', title: '执行会话', running: false },
    ])).toEqual([
      { sessionId: 's1', title: '规划会话', status: '运行中' },
      { sessionId: 's2', title: '执行会话', status: '空闲' },
    ])
  })

  it('renders a missing title as an empty string', () => {
    expect(deliveryCatalog([{ sessionId: 's3', title: undefined, running: false }]))
      .toEqual([{ sessionId: 's3', title: '', status: '空闲' }])
  })

  it('lists an agentless session as 空闲', () => {
    expect(deliveryCatalog([{ sessionId: 's4', title: undefined, running: false }]))
      .toEqual([{ sessionId: 's4', title: '', status: '空闲' }])
  })
})

describe('relayBody', () => {
  it('prepends the sourced header line', () => {
    expect(relayBody('规划会话', 'sess-a', '给出方案')).toBe('来自会话 规划会话\n\n给出方案')
  })

  it('falls back to the session id without a title', () => {
    expect(relayBody(undefined, 'sess-a', 'hi')).toBe('来自会话 sess-a\n\nhi')
  })
})

describe('planDelivery (whole send-side decision)', () => {
  const input = (overrides: Partial<DeliveryPlanInput> = {}): DeliveryPlanInput => ({
    to: '简报会话',
    self: A,
    candidates: CATALOG,
    sourceHop: undefined,
    maxHops: 5,
    text: '把第 2 步做完',
    ...overrides,
  })

  it('delivers to a unique title target with a fresh hop and sourced body', () => {
    expect(planDelivery(input())).toEqual({
      kind: 'deliver',
      targetId: 'sess-d',
      body: '来自会话 规划会话\n\n把第 2 步做完',
      hop: 1,
    })
  })

  it('self-send is rejected with the distinct error', () => {
    const plan = planDelivery(input({ to: 'sess-a' }))
    expect(plan).toMatchObject({ kind: 'blocked' })
    if (plan.kind === 'blocked') expect(plan.error).toContain('不能把消息发送给自己')
  })

  it('ambiguity error lists the candidate id-title pairs', () => {
    const plan = planDelivery(input({ to: '执行会话', self: NO_TITLE }))
    expect(plan).toMatchObject({ kind: 'blocked' })
    if (plan.kind === 'blocked') {
      expect(plan.error).toContain('「执行会话」不唯一')
      expect(plan.error).toContain('sess-b「执行会话」')
      expect(plan.error).toContain('sess-c「执行会话」')
    }
  })

  it('not-found error names the missing target', () => {
    const plan = planDelivery(input({ to: '不存在的标题' }))
    expect(plan).toMatchObject({ kind: 'blocked' })
    if (plan.kind === 'blocked') expect(plan.error).toContain('未找到目标会话「不存在的标题」')
  })

  it('a chain at maxHops is intercepted send-side before resolution', () => {
    const plan = planDelivery(input({ sourceHop: 5 }))
    expect(plan).toMatchObject({ kind: 'blocked' })
    if (plan.kind === 'blocked') {
      expect(plan.error).toContain('maxHops=5')
      expect(plan.error).toContain('投递被拦截')
    }
  })

  it('delivers a relay chain at hop maxHops-1 with the next hop stamped', () => {
    expect(planDelivery(input({ sourceHop: 4 }))).toMatchObject({ kind: 'deliver', hop: 5 })
  })

  it('stamps every delivery with an incremented hop', () => {
    expect(planDelivery(input({ sourceHop: 2 }))).toMatchObject({ kind: 'deliver', hop: 3 })
  })
})