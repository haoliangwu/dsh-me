import { describe, expect, it } from 'vitest'
import {
  approvalBody,
  assistantTurnText,
  bodyForTurnEnd,
  pendingInteractionNotifications,
  playChime,
  questionBody,
  shouldNotify,
  titleFor,
  truncate,
  turnEndOutcome,
  type AudioContextLike,
  type PendingInteractionShape,
  type SessionEventLikeEntryShape,
} from './notification.ts'

interface ToneRecord {
  frequency: number
  startedAt: number
  stoppedAt: number
  oscConnectedTo: unknown
  gainConnectedTo: unknown
  envelope: readonly { op: 'set' | 'ramp'; v: number; t: number }[]
}

/** Fake audio context recording every scheduling call playChime makes. */
function fakeAudioContext(): { ac: AudioContextLike; tones: ToneRecord[] } {
  const tones: ToneRecord[] = []
  const destination = {}
  const ac: AudioContextLike = {
    currentTime: 10,
    destination,
    createOscillator: () => {
      const record: ToneRecord = {
        frequency: 0, startedAt: -1, stoppedAt: -1,
        oscConnectedTo: null, gainConnectedTo: null, envelope: [],
      }
      tones.push(record)
      return {
        frequency: {
          set value(v: number) { record.frequency = v },
        },
        connect: (node: unknown) => { record.oscConnectedTo = node },
        start: (when?: number) => { record.startedAt = when ?? -1 },
        stop: (when?: number) => { record.stoppedAt = when ?? -1 },
      }
    },
    createGain: () => {
      const record = tones[tones.length - 1] as unknown as {
        gainConnectedTo: unknown
        envelope: ToneRecord['envelope']
      }
      const gainNode = {}
      return {
        gain: {
          setValueAtTime: (v: number, t: number) => {
            record.envelope = [...record.envelope, { op: 'set', v, t }]
          },
          exponentialRampToValueAtTime: (v: number, t: number) => {
            record.envelope = [...record.envelope, { op: 'ramp', v, t }]
          },
        },
        connect: (node: unknown) => { record.gainConnectedTo = node },
      }
    },
  }
  return { ac, tones }
}

function interaction(
  key: string,
  kind: string,
  sessionId: string,
  fields?: { questions?: readonly { question?: string }[]; toolName?: string; reason?: string },
): PendingInteractionShape {
  return { key, kind, sessionId, ...(fields === undefined ? {} : fields) }
}

function snapshot(...items: PendingInteractionShape[]): ReadonlyMap<string, PendingInteractionShape> {
  return new Map(items.map(item => [item.sessionId, item]))
}

function assistantEntry(turn: number, text: string, step = 0): SessionEventLikeEntryShape {
  return {
    type: 'event',
    event: {
      type: 'assistant/message',
      data: { turn, step, message: { content: [{ type: 'text', text }] } },
    },
  }
}

describe('turnEndOutcome (test 1: reason mapping)', () => {
  it('maps completed to a completion without truncation', () => {
    expect(turnEndOutcome({ kind: 'completed' })).toEqual({ type: 'completion', truncated: false })
  })

  it('maps max-tokens to a truncated completion', () => {
    expect(turnEndOutcome({ kind: 'max-tokens' })).toEqual({ type: 'completion', truncated: true })
  })

  it('maps error to an error with the failure message', () => {
    expect(turnEndOutcome({ kind: 'error', error: { message: 'boom', code: 'X' } }))
      .toEqual({ type: 'error', message: 'boom' })
  })

  it('maps an error without a message to the fallback', () => {
    expect(turnEndOutcome({ kind: 'error' })).toEqual({ type: 'error', message: 'LLM 调用失败' })
  })

  it('skips aborted', () => {
    expect(turnEndOutcome({ kind: 'aborted', reason: { kind: 'user' } })).toBeNull()
  })

  it('skips blocked', () => {
    expect(turnEndOutcome({ kind: 'blocked' })).toBeNull()
  })

  it('skips interrupted', () => {
    expect(turnEndOutcome({ kind: 'interrupted' })).toBeNull()
  })

  it('skips unknown merge-extensible kinds', () => {
    expect(turnEndOutcome({ kind: 'future-kind' })).toBeNull()
  })

  it('skips a missing reason', () => {
    expect(turnEndOutcome(undefined as never)).toBeNull()
  })
})

describe('shouldNotify (tests 2+3: visibility gate and config toggles)', () => {
  it('does not notify while the document is visible', () => {
    expect(shouldNotify('visible', true)).toBe(false)
  })

  it('notifies while hidden', () => {
    expect(shouldNotify('hidden', true)).toBe(true)
  })

  it('notifies for non-normal non-visible states', () => {
    expect(shouldNotify('prerender' as DocumentVisibilityState, true)).toBe(true)
  })

  it('stays silent when the trigger toggle is off even while hidden', () => {
    expect(shouldNotify('hidden', false)).toBe(false)
  })

  it('stays silent when both the gate and the toggle are off', () => {
    expect(shouldNotify('visible', false)).toBe(false)
  })
})

describe('truncate and bodyForTurnEnd', () => {
  it('keeps short text untouched', () => {
    const text = 'a'.repeat(200)
    expect(truncate(text)).toBe(text)
  })

  it('cuts long text to ~200 code points with an ellipsis', () => {
    const text = 'a'.repeat(250)
    const body = truncate(text)
    expect(body).toBe(`${'a'.repeat(200)}…`)
    expect(Array.from(body).length).toBe(201)
  })

  it('does not split a surrogate pair', () => {
    const text = '𝔞'.repeat(150) // 2 code units per char
    const body = truncate(text)
    expect([...body].length).toBeLessThanOrEqual(201)
    expect(body.endsWith('𝔞…') || body.endsWith('𝔞')).toBe(true)
  })

  it('completion body is the truncated turn text', () => {
    const body = bodyForTurnEnd({ type: 'completion', truncated: false }, 'a'.repeat(250))
    expect(body).toBe(`${'a'.repeat(200)}…`)
  })

  it('max-tokens completion body appends the truncation note', () => {
    const body = bodyForTurnEnd({ type: 'completion', truncated: true }, 'short answer')
    expect(body).toBe('short answer （已达 max-tokens，输出被截断）')
  })

  it('error body is the message verbatim', () => {
    expect(bodyForTurnEnd({ type: 'error', message: 'boom' }, 'ignored text')).toBe('boom')
  })
})

describe('assistantTurnText', () => {
  it('joins text blocks of the turn final assistant/message', () => {
    const entries = [
      assistantEntry(1, 'first'),
      { ...assistantEntry(1, 'final'), event: { type: 'assistant/message', data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'final' }] } } } },
      assistantEntry(2, 'other turn'),
    ]
    expect(assistantTurnText(entries, 1)).toBe('final')
  })

  it('skips transient and non-message entries', () => {
    const entries: SessionEventLikeEntryShape[] = [
      { type: 'transient', event: { type: 'assistant/live-chunk', data: {} } },
      { type: 'event', event: { type: 'user/message', data: {} } },
    ]
    expect(assistantTurnText(entries, 1)).toBe('')
  })

  it('returns empty when the turn has no assistant message', () => {
    expect(assistantTurnText([assistantEntry(3, 'text')], 9)).toBe('')
  })
})

describe('question and approval payloads', () => {
  it('joins question texts as the body', () => {
    expect(questionBody([{ question: '继续吗？' }, { question: '覆盖？' }])).toBe('继续吗？ / 覆盖？')
  })

  it('drops empty questions', () => {
    expect(questionBody([{ question: '' }, { question: 'go?' }])).toBe('go?')
  })

  it('approval body is the tool alone without a reason', () => {
    expect(approvalBody({ toolName: 'bash' })).toBe('bash')
  })

  it('approval body appends the reason after the tool', () => {
    expect(approvalBody({ toolName: 'bash', reason: '需要写 /tmp/x' })).toBe('bash：需要写 /tmp/x')
  })

  it('approval body falls back to the reason when the tool is absent', () => {
    expect(approvalBody({ reason: 'permission escalation' })).toBe('permission escalation')
  })

  it('approval body is empty when neither tool nor reason exists', () => {
    expect(approvalBody({})).toBe('')
  })

  it('titles carry the type marker and session name', () => {
    expect(titleFor('completion', 'my-session')).toBe('[dsh] 完成：my-session')
    expect(titleFor('error', 'my-session')).toBe('[dsh] 错误：my-session')
    expect(titleFor('question', 'my-session')).toBe('[dsh] 提问：my-session')
    expect(titleFor('approval', 'my-session')).toBe('[dsh] 审批：my-session')
  })
})

describe('playChime', () => {
  it('plays two tones with the D6 answer at the default context time', () => {
    const { ac, tones } = fakeAudioContext()
    playChime(ac)
    expect(tones).toHaveLength(2)
    expect(tones.map(t => t.frequency)).toEqual([880, 1174.66])
    expect(tones.map(t => t.startedAt)).toEqual([10, 10.1])
    expect(tones.map(t => t.stoppedAt)).toEqual([10.09, 10.19])
  })

  it('plays a falling low pair for errors', () => {
    const { ac, tones } = fakeAudioContext()
    playChime(ac, 'error')
    expect(tones.map(t => t.frequency)).toEqual([440, 329.63])
    expect(tones.map(t => t.startedAt)).toEqual([10, 10.1])
    expect(tones.map(t => t.stoppedAt)).toEqual([10.09, 10.19])
  })

  it('plays a rising triple for approvals', () => {
    const { ac, tones } = fakeAudioContext()
    playChime(ac, 'approval')
    expect(tones).toHaveLength(3)
    expect(tones.map(t => t.frequency)).toEqual([880, 1174.66, 1567.98])
    expect(tones.map(t => t.startedAt)).toEqual([10, 10.08, 10.16])
    expect(tones.map(t => t.stoppedAt)).toEqual([10.06, 10.14, 10.22])
  })

  it('gives error and approval distinct schedules from default', () => {
    const { ac, tones } = fakeAudioContext()
    playChime(ac, 'default')
    const defaultTones = tones.map(t => `${t.frequency}:${t.startedAt}`).join(',')
    const error = fakeAudioContext()
    playChime(error.ac, 'error')
    const approval = fakeAudioContext()
    playChime(approval.ac, 'approval')
    expect(error.tones.map(t => t.frequency).join(',')).not.toBe(defaultTones)
    expect(approval.tones.map(t => `${t.frequency}:${t.startedAt}`).join(',')).not.toBe(defaultTones)
  })

  it('honours an explicit start offset', () => {
    const { ac, tones } = fakeAudioContext()
    playChime(ac, 'default', 5)
    expect(tones.map(t => t.startedAt)).toEqual([5, 5.1])
    expect(tones.map(t => t.stoppedAt)).toEqual([5.09, 5.19])
  })

  it('schedules gain attack and exponential decay per tone', () => {
    const { ac, tones } = fakeAudioContext()
    playChime(ac, 'default', 10)
    expect(tones[0]?.envelope).toEqual([
      { op: 'set', v: 0.0001, t: 10 },
      { op: 'ramp', v: 0.18, t: 10.01 },
      { op: 'ramp', v: 0.0001, t: 10.09 },
    ])
    expect(tones[1]?.envelope).toEqual([
      { op: 'set', v: 0.0001, t: 10.1 },
      { op: 'ramp', v: 0.18, t: 10.11 },
      { op: 'ramp', v: 0.0001, t: 10.19 },
    ])
  })

  it('wires each oscillator through its gain into the destination', () => {
    const { ac, tones } = fakeAudioContext()
    playChime(ac, 'default')
    for (const tone of tones) {
      expect(tone.oscConnectedTo).not.toBeNull()
      expect(tone.gainConnectedTo).toBe(ac.destination)
    }
    // Each oscillator routes through its own gain node, not one shared chain.
    expect(tones[0]?.oscConnectedTo).not.toBe(tones[1]?.oscConnectedTo)
  })
})

describe('pendingInteractionNotifications (test 4: question/approval triggers from the uiSession pending-interaction face)', () => {
  it('fires a new question key and marks it seen', () => {
    const result = pendingInteractionNotifications(
      new Set(),
      snapshot(interaction('question:1', 'question', 's1', { questions: [{ question: '继续吗？' }] })),
    )
    expect(result.keys).toEqual(['question:1'])
    expect(result.fired).toEqual([{ sessionId: 's1', kind: 'question', body: '继续吗？' }])
  })

  it('fires plan-review interactions as question notifications', () => {
    const result = pendingInteractionNotifications(
      new Set(),
      snapshot(interaction('question:2', 'plan-review', 's2', { questions: [{ question: '批准计划？' }] })),
    )
    expect(result.fired).toEqual([{ sessionId: 's2', kind: 'question', body: '批准计划？' }])
  })

  it('fires a pending approval with tool and reason', () => {
    const result = pendingInteractionNotifications(
      new Set(),
      snapshot(interaction('approval:1', 'approval', 's1', { toolName: 'bash', reason: '需要写 /tmp/x' })),
    )
    expect(result.keys).toEqual(['approval:1'])
    expect(result.fired).toEqual([{ sessionId: 's1', kind: 'approval', body: 'bash：需要写 /tmp/x' }])
  })

  it('fires an approval that carries only a tool name', () => {
    const result = pendingInteractionNotifications(
      new Set(),
      snapshot(interaction('approval:2', 'approval', 's2', { toolName: 'bash' })),
    )
    expect(result.fired).toEqual([{ sessionId: 's2', kind: 'approval', body: 'bash' }])
  })

  it('marks unknown-domain keys seen without firing', () => {
    const result = pendingInteractionNotifications(
      new Set(),
      snapshot(interaction('bg:1', 'background', 's1')),
    )
    expect(result.keys).toEqual(['bg:1'])
    expect(result.fired).toEqual([])
  })

  it('never re-fires a key already seen on a later snapshot', () => {
    const first = pendingInteractionNotifications(new Set(), snapshot(
      interaction('question:1', 'question', 's1', { questions: [{ question: '继续吗？' }] }),
    ))
    const second = pendingInteractionNotifications(
      new Set(first.keys),
      snapshot(interaction('question:1', 'question', 's1', { questions: [{ question: '继续吗？' }] })),
    )
    expect(second.keys).toEqual([])
    expect(second.fired).toEqual([])
  })

  it('does not fire startup-seeded keys (already pending before plugin load)', () => {
    const seeded = new Set(['question:1', 'approval:1'])
    const result = pendingInteractionNotifications(
      seeded,
      snapshot(
        interaction('question:1', 'question', 's1', { questions: [{ question: '继续吗？' }] }),
        interaction('approval:1', 'approval', 's2', { toolName: 'bash' }),
      ),
    )
    expect(result.keys).toEqual([])
    expect(result.fired).toEqual([])
  })

  it('fires only the new key on a mixed snapshot', () => {
    const result = pendingInteractionNotifications(
      new Set(['question:1']),
      snapshot(
        interaction('question:1', 'question', 's1', { questions: [{ question: 'old' }] }),
        interaction('approval:2', 'approval', 's2', { toolName: 'read', reason: 'new' }),
      ),
    )
    expect(result.keys).toEqual(['approval:2'])
    expect(result.fired).toEqual([{ sessionId: 's2', kind: 'approval', body: 'read：new' }])
  })

  it('handles an empty snapshot', () => {
    expect(pendingInteractionNotifications(new Set(), snapshot())).toEqual({ keys: [], fired: [] })
  })
})