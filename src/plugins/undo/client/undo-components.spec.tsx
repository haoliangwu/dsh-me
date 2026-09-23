// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-store'
import { RedoAction } from './RedoAction.tsx'
import { UndoButton } from './UndoButton.tsx'
import type { UndoState } from './undo-state.ts'

afterEach(cleanup)

const t = (key: string): string => ({ 'buttonAria': '撤销', 'redoAria': '重做' })[key] ?? key

/** A static selector hook over one state value. */
function hook(state: UndoState): SnapshotSelectorHook<UndoState> {
  return ((fn: (value: UndoState) => unknown) => fn(state)) as SnapshotSelectorHook<UndoState>
}

function baseState(overrides: Partial<UndoState> = {}): UndoState {
  return {
    lastTurn: 2,
    idle: true,
    undoneTurns: new Map(),
    hiddenKeys: new Set(),
    messageTurn: new Map([['a2', 2]]),
    userTextByTurn: new Map([[2, 'second']]),
    ...overrides,
  }
}

describe('UndoButton', () => {
  it('renders the undo action for the last closed idle turn', () => {
    const undo = vi.fn(async () => true)
    const { getByLabelText } = render(
      <UndoButton messageId="a2" t={t} useUndo={hook(baseState())} undo={undo} />,
    )
    fireEvent.click(getByLabelText('撤销'))
    expect(undo).toHaveBeenCalledWith('a2')
  })

  it('hides once the turn is already undone', () => {
    const { container } = render(
      <UndoButton
        messageId="a2"
        t={t}
        useUndo={hook(baseState({ undoneTurns: new Map([[2, { turn: 2, userMessageId: 'u2', userText: 'second' }]]) }))}
        undo={vi.fn(async () => true)}
      />,
    )
    expect(container.textContent).toBe('')
  })

  it('hides for a non-last turn and while the agent runs', () => {
    const { container: notLast } = render(
      <UndoButton messageId="a2" t={t} useUndo={hook(baseState({ lastTurn: 3 }))} undo={vi.fn()} />,
    )
    expect(notLast.textContent).toBe('')
    const { container: busy } = render(
      <UndoButton messageId="a2" t={t} useUndo={hook(baseState({ idle: false }))} undo={vi.fn()} />,
    )
    expect(busy.textContent).toBe('')
  })

  it('hides for an unknown message', () => {
    const { container } = render(
      <UndoButton messageId="nope" t={t} useUndo={hook(baseState())} undo={vi.fn()} />,
    )
    expect(container.textContent).toBe('')
  })
})

describe('RedoAction', () => {
  it('renders the redo action for an undone turn and fires the redo verb', () => {
    const redo = vi.fn(async () => true)
    const { getByLabelText } = render(
      <RedoAction
        messageId="a2"
        t={t}
        useUndo={hook(baseState({ undoneTurns: new Map([[2, { turn: 2, userMessageId: 'u2', userText: 'second' }]]) }))}
        redo={redo}
      />,
    )
    fireEvent.click(getByLabelText('重做'))
    expect(redo).toHaveBeenCalledTimes(1)
  })

  it('hides once the turn is redone (undone again on the copy)', () => {
    const { container } = render(
      <RedoAction messageId="a2" t={t} useUndo={hook(baseState())} redo={vi.fn(async () => true)} />,
    )
    expect(container.textContent).toBe('')
  })

  it('hides for an unknown message', () => {
    const { container } = render(
      <RedoAction
        messageId="nope"
        t={t}
        useUndo={hook(baseState({ undoneTurns: new Map([[2, { turn: 2, userMessageId: 'u2', userText: 'second' }]]) }))}
        redo={vi.fn(async () => true)}
      />,
    )
    expect(container.textContent).toBe('')
  })
})