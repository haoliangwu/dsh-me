import { describe, expect, it } from 'vitest'
import {
  extractLastAssistantText,
  packSessionSnapshot,
  parseBtwInput,
  parentContextLines,
  resolveTitleTarget,
  selectSnapshotSegments,
  sliceByBytes,
  surfaceEventMessages,
  utf8Length,
  type SnapshotMessage,
  type TitleCandidate,
} from './pure.ts'

const HAN = '你' // 3 UTF-8 bytes

describe('parseBtwInput (dual target channel)', () => {
  it('parses the default path (question only)', () => {
    expect(parseBtwInput(' what is X? ')).toEqual({
      kind: 'parsed',
      target: { kind: 'default' },
      question: 'what is X?',
    })
  })

  it('parses a canonical mention and strips it from the question', () => {
    expect(parseBtwInput('@[执行会话](dsh-session:sess-b) 把第 2 步做完')).toEqual({
      kind: 'parsed',
      target: { kind: 'mention', sessionId: 'sess-b' },
      question: '把第 2 步做完',
    })
  })

  it('parses a mention with an empty label', () => {
    expect(parseBtwInput('@[](dsh-session:sess-c) hi')).toMatchObject({
      kind: 'parsed',
      target: { kind: 'mention', sessionId: 'sess-c' },
      question: 'hi',
    })
  })

  it('prefers the mention when both channels are present', () => {
    expect(parseBtwInput('@[A](dsh-session:sess-a) 标题 :: 问题')).toEqual({
      kind: 'parsed',
      target: { kind: 'mention', sessionId: 'sess-a' },
      question: '标题 :: 问题',
    })
  })

  it('parses the `标题 :: 问题` fallback', () => {
    expect(parseBtwInput(' 规划会话 :: 看看方向 ')).toEqual({
      kind: 'parsed',
      target: { kind: 'title', title: '规划会话' },
      question: '看看方向',
    })
  })

  it('treats a bare `::` (no separator spaces) as the title fallback too', () => {
    expect(parseBtwInput('执行会话::下一步')).toMatchObject({
      kind: 'parsed',
      target: { kind: 'title', title: '执行会话' },
      question: '下一步',
    })
  })

  it('rejects an empty question', () => {
    expect(parseBtwInput('   ')).toEqual({ kind: 'error', text: '/btw needs a question' })
    expect(parseBtwInput('标题 :: ')).toMatchObject({ kind: 'error' })
    expect(parseBtwInput('@[x](dsh-session:s1) ')).toMatchObject({ kind: 'error' })
  })

  it('rejects an empty title before ::', () => {
    expect(parseBtwInput(' :: question')).toMatchObject({ kind: 'error' })
  })
})

describe('resolveTitleTarget (workspace-scoped title match)', () => {
  const candidates: readonly TitleCandidate[] = [
    { sessionId: 's1', title: '规划会话' },
    { sessionId: 's2', title: '执行会话' },
    { sessionId: 's3', title: '执行会话' },
    { sessionId: 's4', title: undefined },
  ]

  it('resolves a unique title', () => {
    expect(resolveTitleTarget('规划会话', candidates)).toEqual({ kind: 'target', sessionId: 's1' })
  })

  it('reports ambiguity with every candidate listed', () => {
    expect(resolveTitleTarget('执行会话', candidates)).toEqual({
      kind: 'ambiguous',
      candidates: [
        { sessionId: 's2', title: '执行会话' },
        { sessionId: 's3', title: '执行会话' },
      ],
    })
  })

  it('reports not-found for an absent title', () => {
    expect(resolveTitleTarget('不存在的会话', candidates)).toEqual({ kind: 'not-found' })
    expect(resolveTitleTarget('s4', candidates)).toEqual({ kind: 'not-found' })
  })
})

describe('utf8Length / sliceByBytes', () => {
  it('measures UTF-8 bytes (multibyte-safe)', () => {
    expect(utf8Length(HAN)).toBe(3)
    expect(utf8Length('abc')).toBe(3)
    expect(utf8Length(`${HAN}🍎`)).toBe(7) // 3 + 4
  })

  it('never splits a code point', () => {
    expect(utf8Length(sliceByBytes(`${HAN}🍎`, 5))).toBeLessThanOrEqual(5)
    expect(sliceByBytes(`${HAN}x`, 3)).toBe(`${HAN}`) // 你(3) fits; x would need 4
    expect(sliceByBytes(`${HAN}x`, 4)).toBe(`${HAN}x`) // 你(3)+x(1) = exactly 4
    expect(sliceByBytes('abcdef', 3)).toBe('abc')
    expect(sliceByBytes('abcdef', 0)).toBe('')
  })
})

describe('selectSnapshotSegments (head/tail budget)', () => {
  const message = (role: 'user' | 'assistant', text: string): SnapshotMessage => ({ role, text })
  const many: readonly SnapshotMessage[] = [
    message('user', 'a'.repeat(100)),
    message('assistant', 'b'.repeat(100)),
    message('user', 'c'.repeat(100)),
    message('assistant', 'd'.repeat(100)),
  ]

  it('keeps the whole conversation within budget, untruncated', () => {
    const result = selectSnapshotSegments(many, 1_000_000)
    expect(result.truncated).toBe(false)
    expect(result.omittedBytes).toBe(0)
    expect(result.head).toContain('user:')
  })

  it('fills head and tail from opposite ends inside the budget', () => {
    const budget = utf8Length(many.flatMap(m => `${m.role}: ${m.text}\n`).join('')) // ~450
    const tight = Math.floor(budget / 2)
    const result = selectSnapshotSegments(many, tight)
    expect(result.truncated).toBe(true)
    expect(result.headBytes + result.tailBytes).toBeLessThanOrEqual(tight)
    expect(result.head.startsWith('user:')).toBe(true)
    expect(result.tail.startsWith('assistant: d')).toBe(true)
  })

  it('reports exactly the omitted bytes and whole messages', () => {
    const result = selectSnapshotSegments(many, 120)
    expect(result.truncated).toBe(true)
    expect(result.omittedBytes).toBeGreaterThan(0)
    expect(result.omittedMessages).toBeGreaterThan(0)
    // every byte is accounted for: total = head + tail + omitted
    const total = utf8Length(many.map(m => `${m.role}: ${m.text}`).join('\n'))
    expect(result.headBytes + result.tailBytes + result.omittedBytes).toBe(total)
  })

  it('keeps the budget boundary with a tiny one-line conversation', () => {
    const one = [message('assistant', 'ok')]
    const result = selectSnapshotSegments(one, 10)
    // "assistant: ok" = 13 bytes → both sides slice the single line: head
    // 5 bytes ("assis"), tail 5 bytes ("assis"), nothing fully omitted.
    expect(result.truncated).toBe(true)
    expect(result.head).toBe('assis')
    expect(result.tail).toBe('assis')
    expect(result.headBytes + result.tailBytes).toBe(10)
    expect(result.omittedMessages).toBe(0)
  })

  it('handles an empty conversation', () => {
    const result = selectSnapshotSegments([], 100)
    expect(result.truncated).toBe(false)
    expect(result.head).toBe('')
    expect(result.tail).toBe('')
  })
})

describe('packSessionSnapshot (structured block)', () => {
  const meta = { sessionId: 'sess-b', title: '执行会话', cwd: '/work/a' }

  it('carries session meta and labeled head/tail segments', () => {
    const packed = packSessionSnapshot(meta, [{ role: 'user', text: 'hi' }], 1000)
    expect(packed).toContain('<referenced-sessions>')
    expect(packed).toContain('id="sess-b"')
    expect(packed).toContain('title="执行会话"')
    expect(packed).toContain('cwd="/work/a"')
    expect(packed).toContain('<head bytes=')
    expect(packed).toContain('user: hi')
  })

  it('declares truncation with exact omission stats when over budget', () => {
    const packed = packSessionSnapshot(meta, [{ role: 'assistant', text: 'x'.repeat(200) }], 100)
    expect(packed).toContain('omitted bytes=')
    expect(packed).toContain('omitted from this snapshot')
  })

  it('states explicitly that it is a read-only snapshot of another session', () => {
    const packed = packSessionSnapshot(meta, [], 100)
    expect(packed).toContain('read-only snapshot of another session (sess-b)')
    expect(packed).toContain('NOT the current conversation history')
  })

  it('falls the title back to the session id', () => {
    const packed = packSessionSnapshot({ sessionId: 's', title: undefined, cwd: undefined }, [], 100)
    expect(packed).toContain('title="s"')
  })

  it('escapes XML-significant characters in the title', () => {
    const packed = packSessionSnapshot({ sessionId: 's', title: 'a<b&"c"', cwd: undefined }, [], 100)
    expect(packed).toContain('title="a&lt;b&amp;&quot;c&quot;"')
  })
})

describe('extractLastAssistantText', () => {
  const message = (role: string, text: string | undefined) => ({
    role,
    content: text === undefined ? [] : [{ type: 'text', text }],
  })

  it('returns the last non-empty assistant text', () => {
    expect(extractLastAssistantText([message('user', 'q'), message('assistant', 'first'), message('assistant', 'final')]))
      .toBe('final')
  })

  it('skips empty assistant steps (max-tokens usage-only steps)', () => {
    expect(extractLastAssistantText([message('user', 'q'), message('assistant', ''), message('assistant', '  real  ')]))
      .toBe('real')
  })

  it('returns empty when no assistant text exists', () => {
    expect(extractLastAssistantText([message('user', 'q')])).toBe('')
    expect(extractLastAssistantText([])).toBe('')
  })
})

describe('parentContextLines (default path)', () => {
  const message = (role: string, text: string) => ({ role, content: [{ type: 'text', text }] })

  it('renders user:/assistant: lines, newest last, limited to 10', () => {
    const many = Array.from({ length: 12 }, (_, i) => message(i % 2 === 0 ? 'user' : 'assistant', `m${i}`))
    const lines = parentContextLines(many).split('\n')
    expect(lines).toHaveLength(10)
    expect(lines[0]).toBe('user: m2')
    expect(lines.at(-1)).toBe('assistant: m11')
  })

  it('skips tool results and empty-text messages', () => {
    expect(parentContextLines([
      { role: 'tool', content: [{ type: 'tool', text: 'ignored' }] },
      message('user', 'q'),
      message('assistant', ''),
    ])).toBe('user: q')
  })

  it('returns empty for an empty history', () => {
    expect(parentContextLines([])).toBe('')
  })
})
describe('surfaceEventMessages (readSurface event projection)', () => {
  it('projects a human user/message event (data.content + source.kind user)', () => {
    expect(surfaceEventMessages([
      { type: 'user/message', data: { content: [{ type: 'text', text: 'BTW靶会话建立：记住暗号紫色河马42' }], source: { kind: 'user' } } },
    ])).toEqual([{ role: 'user', text: 'BTW靶会话建立：记住暗号紫色河马42' }])
  })

  it('skips non-human user events (context injections, references)', () => {
    expect(surfaceEventMessages([
      { type: 'user/message', data: { content: [{ type: 'text', text: 'AGENTS.md 注入' }], source: { kind: 'session-reference' } } },
      { type: 'user/message', data: { content: [{ type: 'text', text: '无源' }], source: {} } },
    ])).toEqual([])
  })

  it('projects an assistant/message event (data.message.content)', () => {
    expect(surfaceEventMessages([
      { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'text', text: '暗号已记' }] } } },
    ])).toEqual([{ role: 'assistant', text: '暗号已记' }])
  })

  it('keeps order and joins multiple text blocks, dropping reasoning blocks', () => {
    expect(surfaceEventMessages([
      { type: 'user/message', data: { content: [{ type: 'text', text: '第一句' }, { type: 'text', text: '第二句' }], source: { kind: 'user' } } },
      { type: 'assistant/message', data: { message: { role: 'assistant', content: [{ type: 'reasoning', text: '思考不算' }, { type: 'text', text: '回答' }] } } },
    ])).toEqual([
      { role: 'user', text: '第一句\n第二句' },
      { role: 'assistant', text: '回答' },
    ])
  })

  it('skips system/message, tool/result, and malformed payloads', () => {
    expect(surfaceEventMessages([
      { type: 'system/message', data: { message: { content: [{ type: 'text', text: '系统' }] } } },
      { type: 'tool/result', data: { message: { content: [{ type: 'text', text: '工具' }] } } },
      'not-an-event',
      { type: 'user/message' },
      { type: 'user/message', data: { content: 'not-an-array', source: { kind: 'user' } } },
    ])).toEqual([])
  })
})
