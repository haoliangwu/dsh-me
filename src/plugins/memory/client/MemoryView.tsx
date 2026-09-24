/**
 * MemoryView: the read-only Memory tab body (the `conversation.view` entry
 * with id `memory`). It fetches the injected memory block once on mount (tab
 * open = component mount — the spec's freshness decision) through the
 * injected `fetchBlock` seam (Connection RPC `/dsh-memory` endpoint `block`),
 * renders the result as markdown through the host's frozen `MarkdownText`
 * primitive (content identical to the injected block; wire-format tag lines
 * are hidden view-side via `prepareMemoryMarkdown`) on a card surface, and
 * offers one manual refresh control.
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
  caption: "The memory block injected for this session — wire-format tags hidden, content identical to the injected block.",
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

/** A single-line note entry: `<note id="14" scope="workspace">content</note>`. */
const NOTE_LINE = /^<note\s+[^>]*>(.*)<\/note>$/

/** A checkpoint open tag carrying its provenance attributes. */
const CHECKPOINT_OPEN = /^<checkpoint\s+([^>]*)>$/

/** Attribute pairs inside an open tag (`id="13" session="…" date="…"`). */
const ATTRIBUTE = /([a-zA-Z][\w-]*)="([^"]*)"/g

/**
 * Pure wrapper / closing tag lines with no content of their own. Hidden from
 * the view entirely — the wire bytes stay untouched upstream.
 */
function isStructuralTag(trimmedLine: string): boolean {
  return (
    trimmedLine === '<project-memory>' ||
    trimmedLine === '</project-memory>' ||
    trimmedLine === '</note>' ||
    trimmedLine === '</checkpoint>' ||
    /^<note\s+[^>]*>$/.test(trimmedLine)
  )
}

/**
 * The muted provenance caption that replaces a raw `<checkpoint …>` open tag:
 * `> Checkpoint · 2026-09-24 · session-abcd…7890`. It keeps the facts a human
 * wants (what / when / which session) and, as a blockquote, doubles as the
 * visual group separator between entries now that the tags are gone.
 * @param attrs - the attribute text between `<checkpoint` and `>`.
 * @returns one markdown blockquote line.
 */
function checkpointCaption(attrs: string): string {
  const fields = new Map<string, string>()
  for (const match of attrs.matchAll(ATTRIBUTE)) fields.set(match[1], match[2])
  const parts = ['Checkpoint']
  const date = fields.get('date')
  if (date !== undefined) parts.push(date)
  const session = fields.get('session')
  if (session !== undefined) {
    parts.push(session.length > 16 ? `${session.slice(0, 12)}…${session.slice(-4)}` : session)
  }
  return `> ${parts.join(' · ')}`
}

/**
 * View-side markdown preparation (presentation only — wire bytes untouched).
 * The wire-format tags are hidden from the rendered view:
 * - pure wrapper / closing tag lines (`<project-memory>`, `</note>`,
 *   `</checkpoint>`, …) drop out entirely;
 * - a content-bearing note line keeps its content, tags stripped;
 * - a `<checkpoint …>` open tag becomes a muted metadata caption line
 *   (`> Checkpoint · date · short session id`) that separates entries.
 * Each of those emitted units gets its own paragraph, so entries never glue
 * together once the tags no longer bound them. A pure tag line that is NOT
 * wire structure still falls back to the inline-code fence — otherwise it
 * would open a CommonMark HTML block (type 7) and swallow the following
 * lines as literal text. Other lines pass through unchanged.
 * @param block - the verbatim injected block.
 * @returns text safe to hand to the host `MarkdownText`.
 */
export function prepareMemoryMarkdown(block: string): string {
  const lines = block.split('\n')
  const out: string[] = []
  // A dropped structural tag ended a paragraph: the next emitted line needs
  // a blank line before it so two entries can never merge into one paragraph.
  let breakPending = false
  const ensureBreak = (): void => {
    if (out.length > 0 && out[out.length - 1] !== '') out.push('')
  }
  /** Emit a line that must stand alone as its own paragraph. */
  const pushIsolated = (text: string): void => {
    if (breakPending) {
      ensureBreak()
      breakPending = false
    }
    ensureBreak()
    out.push(text)
    breakPending = true // require a blank line after (consumed by next emission)
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (isStructuralTag(trimmed)) {
      if (out.length > 0 && out[out.length - 1] !== '') breakPending = true
      continue
    }
    const note = NOTE_LINE.exec(trimmed)
    if (note !== null) {
      pushIsolated(note[1])
      continue
    }
    const checkpoint = CHECKPOINT_OPEN.exec(trimmed)
    if (checkpoint !== null) {
      pushIsolated(checkpointCaption(checkpoint[1]))
      continue
    }
    const tag = TAG_LINE.exec(line)
    if (tag !== null) {
      // Unknown pure tag line (not wire structure): still fenced + isolated
      // so it cannot open a CommonMark HTML block. A backtick inside the tag
      // needs a double fence and padding spaces per CommonMark code-span rules.
      const [, indent, rawTag] = tag
      const fence = rawTag.includes('`') ? '``' : '`'
      const inner = fence === '`' ? rawTag : ` ${rawTag} `
      pushIsolated(`${indent}${fence}${inner}${fence}`)
      continue
    }
    // Ordinary content line (may be blank): pass through, honoring a
    // pending paragraph break (the blank line itself satisfies it).
    if (breakPending) {
      ensureBreak()
      breakPending = false
      if (line.trim() === '') continue // the blank we just pushed is this one
    } else if (line.trim() === '') {
      if (out.length === 0 || out[out.length - 1] === '') continue // collapse runs
    }
    out.push(line)
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
          // (MarkdownBody pattern). prepareMemoryMarkdown hides the wire
          // format first: structural tag lines drop, note tags strip to their
          // content, checkpoint opens become muted `> Checkpoint · …` caption
          // blockquotes (entry separators) — unknown pure tag lines still
          // fence into isolated code spans so they never open a CommonMark
          // HTML block that would swallow the content that follows.
          <div className={css.block} data-memory-block="">
            <MarkdownText text={prepareMemoryMarkdown(state.block)} labels={MEMORY_MARKDOWN_LABELS} />
          </div>
        )}
      </div>
    </div>
  )
}
