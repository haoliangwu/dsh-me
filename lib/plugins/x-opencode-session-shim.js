//#region src/plugins/x-opencode-session-shim/index.ts
/** Cordis plugin name. */
const name = "x-opencode-session-shim";
/** Required services: the agent registry (initiator scope). */
const inject = ["agents"];
/** Header OpenCode Go requires on every request. */
const HEADER_NAME = "x-opencode-session";
/** OpenCode Go endpoint prefix every provider API (anthropic/openai) shares. */
const OPENCODE_GO_ORIGIN = "https://opencode.ai/zen/go";
/** Stable id for agentless calls (no initiator boundary active). */
const AGENTLESS = "dsh";
/** Extract the request URL from any fetch input form. */
function requestUrl(input) {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}
/** Resolve the session id a request should be stamped with. */
function sessionValueFor(currentInitiator) {
	try {
		return String(currentInitiator()?.id ?? AGENTLESS);
	} catch {
		return AGENTLESS;
	}
}
/** Install the fetch patch; disposal restores the original fetch. */
function apply(ctx) {
	const agents = ctx.agents;
	ctx.logger;
	const original = globalThis.fetch;
	const patched = (input, init) => {
		const url = requestUrl(input);
		if (url === void 0 || !url.startsWith(OPENCODE_GO_ORIGIN)) return original(input, init);
		const session = sessionValueFor(() => agents.currentInitiator());
		const headers = new Headers(init?.headers);
		if (init === void 0 && input instanceof Request) for (const [key, value] of input.headers) headers.set(key, value);
		headers.set(HEADER_NAME, session);
		console.info(`[x-opencode-session-shim] opencode-go: ${HEADER_NAME}: ${session}`);
		if (init === void 0 && input instanceof Request) return original(new Request(input, { headers }), void 0);
		return original(input, {
			...init,
			headers
		});
	};
	globalThis.fetch = patched;
	ctx.effect(() => () => {
		globalThis.fetch = original;
	}, "x-opencode-session-shim: restore globalThis.fetch");
}
//#endregion
export { apply, inject, name, sessionValueFor };
