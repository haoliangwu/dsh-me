/**
 * Web /btw command result view, browser half: one keyed row of the
 * `conversation.chat.commandview` slot for the `btw` command name. The
 * generic command row collapses settlement text to one truncated line; this
 * entry renders the child agent's answer as full markdown. Export discipline:
 * packages/client/AGENTS.md.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { BtwCommandCard } from './BtwCommandCard.tsx'
import { en, zh, type BtwCommandKey } from './locales.ts'

export type { BtwCommandKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The btw command row's copy. */
    btw: BtwCommandKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'btw'

/** Required services: the slot registry and the btw row's copy. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the `btw` dictionaries and the keyed command
 * row for the `btw` command name.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-btw: dictionaries')

  ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register(
    { name: 'conversation.chat.commandview', key: 'btw', locale: NS },
    BtwCommandCard,
  ))
}
