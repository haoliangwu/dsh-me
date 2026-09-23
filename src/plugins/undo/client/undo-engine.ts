/**
 * dsh-undo live layer: the per-session undo surface (event-window
 * subscription feeding the derived state, plus the undo/redo RPC verbs with
 * composer refill) and the DOM row hider (design §4.2 — inline
 * `display:none` on `[data-chat-flow-key]` rows, re-applied on React remounts
 * through a MutationObserver, hiding every key the derivation provides —
 * shadowed original rows plus redone-orphan turn-tail rows, restored on
 * dispose).
 */
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  deriveUndoState,
  EMPTY_UNDO_STATE,
  type SessionEventLikeEntryShape,
  type UndoState,
} from './undo-state.ts'

/** RPC channel owned by the host half of this plugin. */
export const CHANNEL = '/dsh-undo'

/** Endpoint under {@link CHANNEL} tombstoning one assistant turn. */
export const ENDPOINT_UNDO = 'undo'

/** Endpoint under {@link CHANNEL} replaying the last undone turn. */
export const ENDPOINT_REDO = 'redo'

/** The observable event window face the session binding exposes. */
export interface SessionEventWindowShape {
  readonly entries: readonly SessionEventLikeEntryShape[]
}

/** The RPC carrier face (structural; the browser Connection handle). */
export interface RpcCallFace {
  call(channel: string, endpoint: string, payload: unknown): Promise<RpcResult<unknown>>
}

/** The injected dependencies one session's {@link UndoSurface} reads. */
export interface UndoSurfaceDeps {
  readonly sessionId: string
  readonly eventSource: { subscribe(listener: () => void): () => void; getSnapshot(): SessionEventWindowShape }
  readonly callRpc: (endpoint: string, payload: unknown) => Promise<boolean>
  readonly setDraft: (text: string) => void
  /** Called synchronously after every state re-derivation. */
  readonly onState?: (state: UndoState) => void
}

/**
 * One session's reactive undo state plus the undo/redo verbs. Implements the
 * observable face the hooks compartment needs (subscribe/getSnapshot); event
 * window changes re-derive the state and notify listeners and the row hider.
 */
export class UndoSurface {
  private state: UndoState = EMPTY_UNDO_STATE
  private readonly listeners = new Set<() => void>()
  private disposed = false
  private readonly off: () => void
  private readonly deps: UndoSurfaceDeps

  constructor(deps: UndoSurfaceDeps) {
    this.deps = deps
    this.state = deriveUndoState(this.deps.eventSource.getSnapshot().entries)
    this.off = this.deps.eventSource.subscribe(() => this.publish())
  }

  /** The last derived undo facts. */
  getSnapshot(): UndoState {
    return this.state
  }

  /** Subscribe to state re-derivations. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Re-derive from the current window and publish. */
  publish(): void {
    if (this.disposed) return
    this.state = deriveUndoState(this.deps.eventSource.getSnapshot().entries)
    this.deps.onState?.(this.state)
    for (const listener of [...this.listeners]) listener()
  }

  /**
   * Tombstone the message's whole turn (host enforces tail + idle). On
   * success the composer is refilled with the turn's original user text.
   * @param messageId - the assistant message to undo.
   * @returns whether the host accepted the undo.
   */
  async undo(messageId: string): Promise<boolean> {
    const turn = this.state.messageTurn.get(messageId)
    const refill = turn === undefined ? undefined : this.state.userTextByTurn.get(turn)
    const ok = await this.deps.callRpc(ENDPOINT_UNDO, { sessionId: this.deps.sessionId, messageId })
    if (ok && refill !== undefined && refill !== '') this.deps.setDraft(refill)
    return ok
  }

  /**
   * Replay the last undone turn (host re-validates the tombstone is still the
   * surface tail). Copy rows render natively; nothing else to do.
   * @returns whether the host accepted the redo.
   */
  async redo(): Promise<boolean> {
    return this.deps.callRpc(ENDPOINT_REDO, { sessionId: this.deps.sessionId })
  }

  /** Unsubscribe from the window and never re-derive again. */
  dispose(): void {
    this.disposed = true
    this.listeners.clear()
    this.off()
  }
}

/**
 * The DOM row hider (design §4.2): every `[data-chat-flow-key]` row whose key
 * is in the provided set gets inline `display:none` — shadowed original rows
 * and redone-orphan turn-tail rows alike. React remounts drop inline styles,
 * so a MutationObserver re-applies on added/removed rows; dispose restores
 * every row this hider hid.
 */
export class RowHider {
  private readonly hidden = new Set<HTMLElement>()
  private observer: MutationObserver | undefined
  private observingNode: HTMLElement | null = null
  private readonly container: () => HTMLElement | null
  private readonly keys: () => ReadonlySet<string>

  constructor(container: () => HTMLElement | null, keys: () => ReadonlySet<string>) {
    this.container = container
    this.keys = keys
  }

  /** (Re)apply hiding over the current container rows and keep the observer attached. */
  apply(): void {
    const root = this.container()
    if (root === null) return
    this.attachObserver(root)
    const hiddenKeys = this.keys()
    for (const row of root.querySelectorAll<HTMLElement>('[data-chat-flow-key]')) {
      const key = row.dataset.chatFlowKey ?? ''
      // Every key in the set hides, turn-tail keys included. The set only
      // ever holds shadowed sourceEventSeqs-derived keys (surface log seqs —
      // turn-tail seats are synthetic, anchored at turn/end seq + 0.1, so
      // they can never be shadowed) plus the derived redone-orphan tails, so
      // no other path can inject a turn-tail key into it.
      const shouldHide = hiddenKeys.has(key)
      if (shouldHide) {
        row.style.display = 'none'
        this.hidden.add(row)
      } else if (this.hidden.delete(row)) {
        row.style.display = ''
      }
    }
  }

  /** Attach the remount observer once per container node. */
  private attachObserver(root: HTMLElement): void {
    if (this.observingNode === root) return
    this.detachObserver()
    this.observingNode = root
    this.observer = new MutationObserver(() => { this.apply() })
    this.observer.observe(root, { childList: true, subtree: true })
  }

  /** Restore every hidden row and drop the observer. */
  dispose(): void {
    this.detachObserver()
    for (const row of this.hidden) row.style.display = ''
    this.hidden.clear()
  }

  private detachObserver(): void {
    this.observer?.disconnect()
    this.observer = undefined
    this.observingNode = null
  }
}