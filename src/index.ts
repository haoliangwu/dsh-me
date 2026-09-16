/**
 * dsh-me package-root anchor, node half.
 *
 * dsh-client-modules keys the `dsh.client` scan on each mounted fiber's
 * package-root entry name (subpath fibers are skipped: exactPackageSpecifier
 * rejects them), so at least one fiber must mount the bare package specifier
 * `dsh-me` for the merged client bundle to reach __DSH_BOOT__. This anchor is
 * that fiber; the real plugins mount from their own subpath insert rows.
 */
import type { Context } from '@deepseek-ai/cordis'

/** Cordis plugin name. */
export const name = 'dsh-me'

/** Required services: none — the anchor only exists to key the client scan. */
export const inject = []

/** No-op: the mounted plugins own all behavior. */
export function apply(_ctx: Context): void {}
