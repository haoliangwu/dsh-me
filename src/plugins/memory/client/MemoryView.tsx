/**
 * MemoryView: the read-only Memory tab body (the `conversation.view` entry
 * with id `memory`). It fetches the injected memory block once on mount (tab
 * open = component mount — the spec's freshness decision) through the
 * injected `fetchBlock` seam (Connection RPC `/dsh-memory` endpoint `block`),
 * renders the result VERBATIM in a monospace `<pre>` — the model's-eye view,
 * exactly what the system injects — and offers one manual refresh control.
 * No polling, no push: cross-session store changes are only picked up by a
 * deliberate refresh (the honest semantics under manual refresh).
 *
 * States: first-load `loading`, RPC failure `error` (+ Retry), settled-empty
 * `empty` ("No memories for this session yet"), settled-non-empty `ready`.
 * A background refresh keeps the current block on screen while the request is
 * in flight (stale-while-revalidate under manual refresh). Styling lives in
 * its own CSS module — hashed class names, so host CSS can never override the
 * injected view (the known dsh injected-class gotcha).
 */
import { useEffect, useRef, useState } from 'react'
import type { RpcResult } from '@deepseek-ai/dsh-host-apiproxy/api'
import css from './memory.module.css'

/** Host payload for the `block` endpoint: the verbatim injected block ('' when there is none). */
export interface MemoryBlockResponse {
  readonly block: string
}

/** Business face injected by the client half's slot registration. */
export interface MemoryViewInjected {
  /** The session whose injection this tab shows (slot scope key). */
  readonly sessionId: string
  /** The session's workspace cwd (block scoping input). */
  readonly cwd: string
  /** One block fetch against the host channel; resolves the Connection-RPC envelope. */
  fetchBlock(): Promise<RpcResult<MemoryBlockResponse>>
}

/** Every user-facing string of the tab, exported so the spec pins copy to one source. */
export const MEMORY_VIEW_COPY = {
  caption: "The memory block injected for this session, verbatim — the model's-eye view.",
  loading: 'Loading memory block…',
  error: "Couldn't load the memory block.",
  retry: 'Retry',
  empty: 'No memories for this session yet',
  refresh: 'Refresh',
} as const

/** Derived view state over the single fetch seam. */
type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly block: string }

/**
 * Render the read-only Memory tab for one session.
 * @param props - the injected business face (identity + fetch seam).
 * @returns the toolbar + state body (code block / notice).
 */
export function MemoryView({ fetchBlock }: MemoryViewInjected) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [refreshing, setRefreshing] = useState(false)
  // Monotonic request generation: a late resolution (after unmount or after a
  // superseding refresh) must never write a stale state.
  const generation = useRef(0)
  const fetchRef = useRef(fetchBlock)
  fetchRef.current = fetchBlock

  const load = async (background: boolean): Promise<void> => {
    generation.current += 1
    const request = generation.current
    if (background) setRefreshing(true)
    else setState({ kind: 'loading' })
    try {
      const result = await fetchRef.current()
      if (request !== generation.current) return
      setState(result.ok ? { kind: 'ready', block: result.value.block } : { kind: 'error' })
    } catch {
      if (request === generation.current) setState({ kind: 'error' })
    } finally {
      if (request === generation.current) setRefreshing(false)
    }
  }

  useEffect(() => {
    void load(false)
    return () => {
      generation.current += 1 // invalidate in-flight requests on unmount
    }
    // Mount-only: tab open = component mount (spec freshness decision).
  }, [])

  return (
    // Composer-overlay posture (TrajectoryView pattern): the host hides the
    // width handles, turns .scrollBody into a pure clipping box, and pins the
    // composer absolutely — so this root is full-bleed and scrolls ITSELF.
    <div className={css.root} data-conversation-composer-overlay="">
      <div className={css.toolbar}>
        <span className={css.caption}>{MEMORY_VIEW_COPY.caption}</span>
        <button
          type="button"
          className={css.button}
          onClick={() => void load(true)}
          disabled={refreshing || state.kind === 'loading'}
        >
          {MEMORY_VIEW_COPY.refresh}
        </button>
      </div>
      {state.kind === 'loading' ? (
        <p className={css.notice}>{MEMORY_VIEW_COPY.loading}</p>
      ) : state.kind === 'error' ? (
        <div className={css.notice} data-notice="error">
          <span>{MEMORY_VIEW_COPY.error}</span>
          <button type="button" className={css.button} onClick={() => void load(false)}>
            {MEMORY_VIEW_COPY.retry}
          </button>
        </div>
      ) : state.block === '' ? (
        <p className={css.notice}>{MEMORY_VIEW_COPY.empty}</p>
      ) : (
        <pre className={css.block}>{state.block}</pre>
      )}
    </div>
  )
}
