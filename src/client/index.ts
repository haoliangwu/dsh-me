/**
 * dsh-me merged browser client entry (the single `dsh.client` channel).
 *
 * One package ships ONE client bundle: this entry aggregates every plugin's
 * client half. A future plugin with UI adds its own sub-client under
 * src/plugins/<name>/client and is composed here via ctx.plugin().
 */
export { apply, inject } from '../plugins/peak-rate/client/index.ts'
