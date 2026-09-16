/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-ui-peak-rate`.
 * @module @deepseek-ai/dsh-ui-peak-rate/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = 'dsh-ui-peak-rate'

/** Cordis companion plugin name. */
export const name = 'client-ui-peak-rate-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: one list-slot contribution whose disposal is proven
 * by the slot registry; the plugin emits no cordis events and owns no
 * cross-plugin mutable state.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns The installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
