// @vitest-environment jsdom
/**
 * ShortcutsHelp component spec: props fed directly (model on
 * btw-command-card.client.spec.tsx), with the platform primitives package
 * stubbed through the vitest alias — the Modal stub renders its title /
 * closeLabel / description / children so the closed state, zh/en copy, row
 * content, and the close callback are all observable. The slots runtime is
 * stubbed away too: the inject hooks arrive here as plain selector functions
 * (useBindings/useOpen), and the four GlobalStandardProps members this repo's
 * merges make required are no-ops.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ShortcutsHelp, type ShortcutsHelpProps } from './ShortcutsHelp.tsx'
import { en, zh } from './locales.ts'

afterEach(cleanup)

/** The binding-snapshot union the useBindings selector reads. */
type BindingSnapshot = Readonly<Partial<Record<'sidebar' | 'rightbar' | 'help', string>>>

/** One props bundle: open state, binding strings, locale dict, and a close spy. */
function propsFor(open: boolean, bindings: BindingSnapshot, dict: Record<string, string>, close = () => {}) {
  const t = (key: string): string => dict[key] ?? key
  return {
    t: t as never,
    close,
    useSessions: () => undefined,
    useSessionPendingInteraction: () => undefined,
    useWorkspaces: () => undefined,
    usePanelInfo: () => undefined,
    useOpen: <S,>(sel: (value: boolean) => S): S => sel(open),
    useBindings: <S,>(sel: (value: BindingSnapshot) => S): S => sel(bindings),
  } as unknown as ShortcutsHelpProps
}

describe('ShortcutsHelp', () => {
  it('renders one row per bound action with its binding label when open', () => {
    const view = render(<ShortcutsHelp {...propsFor(true, { sidebar: '⌘B', rightbar: '⌘I', help: '⇧?' }, zh)} />)
    expect(view.getByText('键盘快捷键')).toBeDefined()
    expect(view.getByText('收起/展开侧边栏')).toBeDefined()
    expect(view.getByText('⌘B')).toBeDefined()
    expect(view.getByText('开/关右面板')).toBeDefined()
    expect(view.getByText('⌘I')).toBeDefined()
    expect(view.getByText('打开帮助浮层')).toBeDefined()
    expect(view.getByText('⇧?')).toBeDefined()
  })

  it('renders the English copy with an English locale prop', () => {
    const view = render(<ShortcutsHelp {...propsFor(true, { sidebar: 'Ctrl+B', rightbar: 'Ctrl+I', help: '?' }, en)} />)
    expect(view.getByText('Keyboard shortcuts')).toBeDefined()
    expect(view.getByText('Toggle sidebar')).toBeDefined()
    expect(view.getByText('Ctrl+B')).toBeDefined()
  })

  it('renders the rebinding hint as the modal description', () => {
    const view = render(<ShortcutsHelp {...propsFor(true, { sidebar: '⌘B' }, zh)} />)
    expect(view.getByText(/profile 配置/)).toBeDefined()
  })

  it('renders nothing while closed', () => {
    const view = render(<ShortcutsHelp {...propsFor(false, { sidebar: '⌘B' }, zh)} />)
    expect(view.container.textContent).toBe('')
  })

  it('omits rows for actions without a binding string', () => {
    const view = render(<ShortcutsHelp {...propsFor(true, { sidebar: '⌘B' }, zh)} />)
    expect(view.queryByText('开/关右面板')).toBeNull()
    expect(view.queryByText('打开帮助浮层')).toBeNull()
  })

  it('fires the close callback from the Modal close affordance', () => {
    const close = vi.fn()
    render(<ShortcutsHelp {...propsFor(true, { sidebar: '⌘B' }, zh, close)} />)
    fireEvent.click(screen.getByText('关闭'))
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('Escape flow: the engine consumed-Escape path closes the overlay through the props seam', () => {
    const close = vi.fn()
    const view = render(<ShortcutsHelp {...propsFor(true, { sidebar: '⌘B' }, zh, close)} />)
    expect(view.getByText('键盘快捷键')).toBeDefined()
    // The apply body's consumed-Escape handler (US-8) flips the shared open
    // store via setOpen(false) — the same seam the injected `close` binds —
    // so the useOpen selector re-renders this component closed.
    view.rerender(<ShortcutsHelp {...propsFor(false, { sidebar: '⌘B' }, zh, close)} />)
    expect(view.container.textContent).toBe('')
    // The engine path closes the store directly; the Modal onClose seam is
    // not involved (that path is asserted above).
    expect(close).not.toHaveBeenCalled()
  })

  it('re-renders closed when the open selector flips', () => {
    const view = render(<ShortcutsHelp {...propsFor(true, { sidebar: '⌘B' }, zh)} />)
    expect(view.getByText('键盘快捷键')).toBeDefined()
    view.rerender(<ShortcutsHelp {...propsFor(false, { sidebar: '⌘B' }, zh)} />)
    expect(view.container.textContent).toBe('')
  })
})