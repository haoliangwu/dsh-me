/**
 * dsh-me merged browser client entry (the single `dsh.client` channel).
 *
 * One package ships ONE client bundle: this entry aggregates every plugin's
 * client half. A future plugin with UI adds its own sub-client under
 * src/plugins/<name>/client and is composed here via ctx.plugin().
 */
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyPeakRate, inject as peakRateInject } from '../plugins/peak-rate/client/index.ts'
import { apply as applyNotification, inject as notificationInject } from '../plugins/notification/client/index.ts'
import { apply as applyBtw, inject as btwInject } from '../plugins/btw/client/index.ts'

/** Required services: the union of every aggregated client half. */
export const inject = [...new Set([...peakRateInject, ...notificationInject, ...btwInject])]

/**
 * Apply every aggregated client half against the one merged bundle context.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  applyPeakRate(ctx)
  applyNotification(ctx)
  applyBtw(ctx)
}