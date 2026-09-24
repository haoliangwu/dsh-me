/**
 * dsh-btw — `/btw` command: answer a side question in a fresh child agent
 * without polluting the main agent's context.
 *
 * The command's context source is the parent session by default, or any
 * same-workspace session addressed by a canonical `@[label](dsh-session:id)`
 * mention or the `标题 :: 问题` text fallback. A targeted session is read
 * through `ctx.sessionQuery.readSurface` and packed into a head/tail byte-
 * budgeted `<referenced-sessions>`-style read-only snapshot. The child agent
 * runs with the current default model selection, receives the context plus
 * the question as a followup, and its answer is extracted from the derived
 * surface and returned straight to the UI (`recordInput: false` — the parent
 * log stays untouched). The child session records the caller as
 * `parentSession` with `origin: 'subagent'` and a `delegationDepth` budget
 * (OpenCode parentID-lineage semantics), and `/btw` invoked from inside a
 * delegated child is rejected.
 *
 * @module dsh-btw
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type { SessionTitleObservationResult } from '@deepseek-ai/dsh-session-query'
import {
  extractLastAssistantText,
  packSessionSnapshot,
  parentContextLines,
  parseBtwInput,
  resolveTitleTarget,
  surfaceEventMessages,
  type TitleCandidate,
} from './pure.ts'

/** Stable Cordis plugin name. */
export const name = 'dsh-btw'

/** Core services the command handler needs. */
export const inject = ['agentDefaultModel', 'agents', 'commands', 'sessionQuery']

/** How many parent messages to carry into the child (default path). */
const CONTEXT_MESSAGE_LIMIT = 10

/** Head+tail byte budget for one referenced-session snapshot (tuning knob). */
export const SNAPSHOT_BYTE_BUDGET = 16 * 1024

/**
 * Delegation recursion cap (borrowed from OpenCode's `subagent_depth`, default
 * 1): a `/btw` run from inside a delegated child would nest agents one level
 * too deep, so any parent that is itself a child is rejected.
 */
export const MAX_DELEGATION_DEPTH = 1

/** Fold a title from one title-observation result (fulfilled → snapshot title). */
function titleOfObservation(result: SessionTitleObservationResult | undefined): string | undefined {
  if (result === undefined || result.status !== 'fulfilled') return undefined
  const title = result.value.title
  return title?.title
}

/**
 * The child agent's followup prompt: the bare question when no context was
 * assembled, otherwise the context plus the question (spec wording differs by
 * whether the context is the parent's own conversation or a snapshot).
 * @param question - the parsed `/btw` question.
 * @param context - the assembled context text ('' → question only).
 * @param fromCurrentSession - whether the context is the parent conversation.
 * @returns the followup prompt.
 */
function buildPrompt(question: string, context: string, fromCurrentSession: boolean): string {
  if (context === '') return question
  const sourceLabel = fromCurrentSession ? 'the current conversation' : 'another session (read-only snapshot)'
  const answerBase = fromCurrentSession ? 'the context above' : 'the snapshot above'
  return `Context from ${sourceLabel}:\n${context}\n\nQuestion: ${question}\n\nAnswer the question based on ${answerBase}, or say so when it does not answer it.`
}

export function apply(ctx: Context) {
  ctx.commands.register({
    name: 'btw',
    description: 'Answer a side question in a separate agent without touching the current conversation',
    input: { hint: 'your question, or @session / 标题 :: question' },
    // The question belongs to the child agent's prompt, not the parent log.
    recordInput: false,
    async handler(invocation) {
      const parent = invocation.agent
      invocation.signal.throwIfAborted()
      const parsed = parseBtwInput(invocation.rawInput)
      if (parsed.kind === 'error') return { kind: 'error', text: parsed.text }

      const defaultModel = ctx.get('agentDefaultModel')
      if (defaultModel === undefined) return { kind: 'error', text: '/btw: no agentDefaultModel service mounted' }
      const selection = defaultModel.currentSelection()

      // Depth gate (borrowed from OpenCode's subagent_depth cap): `/btw` from
      // a delegated child would nest delegation beyond the budget.
      const parentDepth = parent.session.header.delegationDepth ?? 0
      if (parentDepth >= MAX_DELEGATION_DEPTH) {
        return {
          kind: 'error',
          text: `/btw unavailable inside a delegated subagent (delegation depth ${String(parentDepth)}); ask from a top-level session`,
        }
      }


      // 1. Resolve the context source.
      const callerCwd = parent.session.header.cwd
      // Same-workspace membership gate (spec): the target must share the
      // caller's cwd. `null` matches a workspace-less session.
      let inWorkspace: SessionHeader[]
      try {
        inWorkspace = await ctx.sessionQuery
          .filterSessions([{ kind: 'cwd', values: [callerCwd ?? null] }], invocation.signal)
          .then(records => records.map(record => record.header))
      } catch (error: unknown) {
        invocation.signal.throwIfAborted()
        return { kind: 'error', text: `/btw: session query failed: ${error instanceof Error ? error.message : String(error)}` }
      }

      let targetId: string
      if (parsed.target.kind === 'default') {
        targetId = parent.id
      } else if (parsed.target.kind === 'mention') {
        if (!inWorkspace.some(header => header.id === parsed.target.sessionId)) {
          return { kind: 'error', text: `目标会话不在当前 workspace：${parsed.target.sessionId}` }
        }
        targetId = parsed.target.sessionId
      } else {
        // Title channel: fold titles for the whole workspace, then resolve.
        // Title addressing is for human-visible conversations only: delegated
        // subagent sessions (including prior btw children) are excluded so
        // their derived titles cannot collide with `::` targets.
        const addressable = new Set(
          inWorkspace.filter(header => header.origin !== 'subagent').map(header => header.id),
        )
        const workspaceIds = [...addressable]
        const observations = await ctx.sessionQuery.readTitleSnapshots(workspaceIds, invocation.signal)
        const candidates: TitleCandidate[] = observations
          .filter(result => result.status === 'fulfilled' && addressable.has(result.sessionId))
          .map(result => ({ sessionId: result.sessionId, title: titleOfObservation(result) }))
        const resolution = resolveTitleTarget(parsed.target.title, candidates)
        if (resolution.kind === 'target') {
          targetId = resolution.sessionId
        } else if (resolution.kind === 'not-found') {
          return { kind: 'error', text: `未找到目标会话「${parsed.target.title}」：当前 workspace 内没有标题全等命中的会话` }
        } else {
          const listed = resolution.candidates
            .map(candidate => `${candidate.sessionId}「${candidate.title ?? '(无标题)'}」`)
            .join('，')
          return { kind: 'error', text: `目标标题「${parsed.target.title}」不唯一（命中 ${String(resolution.candidates.length)} 个会话：${listed}），请用 @ 提及精确定位` }
        }
      }

      // 2. Assemble the child's context: the parent's recent conversation
      // (existing default behavior) or this session's packed read-only
      // snapshot.
      let context: string
      if (targetId === parent.id) {
        context = parentContextLines(parent.session.deriveMessages(), CONTEXT_MESSAGE_LIMIT)
      } else {
        const surface = await ctx.sessionQuery.readSurface(SessionId(targetId))
        invocation.signal.throwIfAborted()
        const [titleObservation] = await ctx.sessionQuery.readTitleSnapshots([SessionId(targetId)], invocation.signal)
        const targetTitle = titleOfObservation(titleObservation)
        const packed = packSessionSnapshot(
          { sessionId: targetId, title: targetTitle, cwd: surface.session.cwd },
          surfaceEventMessages(surface.events),
          SNAPSHOT_BYTE_BUDGET,
        )
        context = packed
      }
      const prompt = buildPrompt(parsed.question, context, targetId === parent.id)

      // 3. Create a fresh child agent with the same model selection, drive it,
      // and always tear the handle down (cancellation or not).
      let answer = ''
      const handle = await ctx.agents.create({
        sessionId: SessionId(`btw-${randomUUID()}`),
        meta: {
          cwd: callerCwd,
          // Lineage (borrowed from the harness child-session convention,
          // mirroring OpenCode's parentID sessions): the btw child is recorded
          // as a delegated descendant of the caller, one level deeper, so the
          // recursion budget survives persistence and the session tree can
          // present the child under its parent.
          parentSession: parent.session.header.id,
          origin: 'subagent',
          delegationDepth: parentDepth + 1,
        },
        agentOptions: { provider: selection.provider, model: selection.model },
        setup: (agentCtx) => {
          const selected: ModelSelectionRef = { current: selection, assembled: undefined }
          installModelSelection(agentCtx, selected)
        },
        signal: invocation.signal,
      })
      try {
        invocation.signal.throwIfAborted()
        handle.agent.followup(createUserMessage({
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'user' },
        }))
        await handle.agent.whenIdle()
        invocation.signal.throwIfAborted()
        // 4. Extract the answer from the derived surface (no snapshot-events paths).
        answer = extractLastAssistantText(handle.agent.session.deriveMessages())
      } finally {
        // Ownership contract: the child handle must be disposed even on abort.
        await handle.dispose()
      }

      if (invocation.signal.aborted) {
        return { kind: 'error', text: '/btw cancelled' }
      }
      return answer === ''
        ? { kind: 'error', text: '/btw: child agent produced no answer' }
        : { kind: 'success', text: answer }
    },
  })
}