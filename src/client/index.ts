/**
 * dsh-me merged browser client entry (the single `dsh.client` channel).
 *
 * One package ships ONE client bundle: this entry aggregates every plugin's
 * client half. A future plugin with UI adds its own sub-client under
 * src/plugins/<name>/client and is composed here via ctx.plugin().
 *
 * Per-profile mount gating cannot live here: the browser Loader creates this
 * bundle's entry with no config (client-modules' `create` passes `{name}`
 * only; WebBootEntry carries no host-row config), so a host row's
 * `config:` never reaches the browser. A half that must be per-profile
 * optional gates itself against host-side state (dsh-memory's client probes
 * its channel and skips the tab when the host half is disabled).
 */
import type { Context } from '@deepseek-ai/cordis'
import { apply as applyPeakRate, inject as peakRateInject } from '../plugins/peak-rate/client/index.ts'
import { apply as applyNotification, inject as notificationInject } from '../plugins/notification/client/index.ts'
import { apply as applyBtw, inject as btwInject } from '../plugins/btw/client/index.ts'
import { apply as applyReference, inject as referenceInject } from '../plugins/reference/client/index.ts'
import { apply as applyUndo, inject as undoInject } from '../plugins/undo/client/index.ts'
import { apply as applyMemory, inject as memoryInject } from '../plugins/memory/client/index.ts'

/** Required services: the union of every aggregated client half. */
export const inject = [...new Set([
  ...peakRateInject,
  ...notificationInject,
  ...btwInject,
  ...referenceInject,
  ...undoInject,
  ...memoryInject,
])]

/**
 * Apply every aggregated client half against the one merged bundle context.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  applyPeakRate(ctx)
  applyNotification(ctx)
  applyBtw(ctx)
  applyReference(ctx)
  applyUndo(ctx)
  applyMemory(ctx)
}
