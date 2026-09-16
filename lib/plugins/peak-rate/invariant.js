//#region src/plugins/peak-rate/invariant.ts
const PACKAGE_NAME = "dsh-ui-peak-rate";
/** Cordis companion plugin name. */
const name = "client-ui-peak-rate-invariant";
/** Service required before the companion can reserve package ownership. */
const inject = ["invariants"];
/**
* No runtime invariant: one list-slot contribution whose disposal is proven
* by the slot registry; the plugin emits no cordis events and owns no
* cross-plugin mutable state.
*/
const install = () => {};
/**
* Register this package's invariant companion.
* @param ctx - Cordis context carrying the invariant service.
* @returns The installed registration's disposer after setup succeeds.
*/
const apply = (ctx) => Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install));
//#endregion
export { apply, inject, name };
