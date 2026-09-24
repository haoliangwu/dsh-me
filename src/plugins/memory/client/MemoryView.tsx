/**
 * MemoryView: the read-only Memory tab body (the `conversation.view` entry
 * with id `memory`). It fetches the injected memory block once on mount (tab
 * open = component mount — the spec's freshness decision) through the
 * injected `fetchBlock` seam (Connection RPC `/dsh-memory` endpoint `block`),
 * renders the result as markdown through the host's frozen `MarkdownText`
 * primitive (same injected bytes, rendered — the model's-eye view) on a card
 * surface, and offers one manual refresh control.
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
import { MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
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
  caption: "The memory block injected for this session, rendered as markdown — the model's-eye view.",
  loading: 'Loading memory block…',
  error: "Couldn't load the memory block.",
  retry: 'Retry',
  empty: 'No memories for this session yet',
  refresh: 'Refresh',
} as const

/**
 * Labels for the `MarkdownText` primitive (it owns no locale fallback). The
 * tab's chrome is plain English, so the code-block copy buttons match it.
 */
export const MEMORY_MARKDOWN_LABELS: MarkdownLabels = {
  code: { copyLabel: 'Copy', copiedLabel: 'Copied' },
  footnotes: 'Footnotes',
}

/**
 * A pure wire-format tag line: `<project-memory>`, `<note id="1" …>`,
 * `</checkpoint>` — the whole line is one open/close tag, nothing else.
 */
const TAG_LINE = /^(\s*)(<\/?[a-zA-Z][^>]*>)\s*$/

/**
 * View-side markdown preparation (presentation only — wire bytes untouched).
 * A tag line starting a paragraph opens a CommonMark HTML block (type 7),
 * which swallows every following line until a blank line — so markdown
 * inside the tag region (inline code, ordered lists) would never parse.
 * Fix: wrap each pure tag line in an inline-code fence (byte-visible, styled
 * as code = visually distinct from content) and isolate it in its own
 * paragraph with blank lines. Non-tag lines pass through unchanged.
 * @param block - the verbatim injected block.
 * @returns text safe to hand to the host `MarkdownText`.
 */
export function prepareMemoryMarkdown(block: string): string {
  const lines = block.split('\n')
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const match = TAG_LINE.exec(lines[i])
    if (match === null) {
      out.push(lines[i])
      continue
    }
    const [, indent, tag] = match
    // Own paragraph: blank line before, unless already at a block boundary.
    if (out.length > 0 && out[out.length - 1] !== '') out.push('')
    // Inline-code span; a backtick inside the tag needs a double fence and
    // padding spaces per CommonMark code-span rules.
    const fence = tag.includes('`') ? '``' : '`'
    const inner = fence === '`' ? tag : ` ${tag} `
    out.push(`${indent}${fence}${inner}${fence}`)
    // Blank line after, unless the next line is already blank / no next line.
    const next = lines[i + 1]
    if (next !== undefined && next.trim() !== '') out.push('')
  }
  return out.join('\n')
}

/** Derived view state over the single fetch seam. */
type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly block: string }

/**
 * Render the read-only Memory tab for one session.
 * @param props - the injected business face (identity + fetch seam).
 * @returns the toolbar + state body (markdown card / notice).
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
      {/* Content column: bounded to the host chat content width and centered
          on the composer's axis (ChatView's .column contract). The composer
          seat's top fade band is only translucent outside the composer card,
          so nothing that scrolls may render in those side gutters. */}
      <div className={css.column}>
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
          // Card surface scopes host- MarkdownText's own CSS-module styles
          // (MarkdownBody pattern). Tag lines are preprocessed into isolated
          // code spans so they never open a CommonMark HTML block (which would
          // swallow the markdown inside the tag region as literal text) —
          // the tags still render as byte-visible text, never as elements.
          <div className={css.block} data-memory-block="">
            <MarkdownText text={prepareMemoryMarkdown(state.block)} labels={MEMORY_MARKDOWN_LABELS} />
          </div>
        )}
      </div>
    </div>
  )
}
