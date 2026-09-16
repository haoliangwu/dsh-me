import z from "@deepseek-ai/schemastery";
//#region src/plugins/peak-rate/index.ts
/** Cordis plugin name. */
const name = "client-ui-peak-rate";
/**
* Required services. The web route is attached at runtime via
* `ctx.inject(['webServer'])` (vision-toolkit pattern) so non-web profiles
* simply skip the channel instead of pending forever.
*/
const inject = [];
const Config = z.object({
	providers: z.array(String).default(["deepseek-official"]),
	peakWindows: z.transform(z.array(z.tuple([Number, Number])), (windows, options) => {
		const typed = windows;
		for (const [start, end] of typed) if (!(start >= 0 && start < end && end <= 24)) throw new z.ValidationError(`peak window [${start},${end}] must satisfy 0 <= start < end <= 24`, options);
		return typed;
	}).default([[1, 4], [6, 10]]),
	multiplier: z.number().default(2)
});
/** RPC channel owned by this plugin. */
const CHANNEL = "/peak-rate";
/** Endpoint under {@link CHANNEL} returning the configured peak-rate policy. */
const ENDPOINT_CONFIG = "config";
/**
* Mount the host RPC handler that returns the validated peak-rate policy.
* @param ctx - host plugin context carrying the Connection service.
* @param config - validated {@link Config}.
*/
function apply(ctx, config) {
	const response = {
		providers: config.providers,
		peakWindows: config.peakWindows,
		multiplier: config.multiplier
	};
	ctx.inject(["webServer"], (webCtx) => {
		webCtx.effect(() => webCtx.webServer.register({
			kind: "prefix",
			path: CHANNEL,
			handler: (req, res) => {
				serveChannel(req, res, CHANNEL, (endpoint, payload) => {
					if (endpoint === ENDPOINT_CONFIG) return Promise.resolve({
						ok: true,
						value: response
					});
					return Promise.resolve({
						ok: false,
						error: {
							code: "internal",
							message: `unknown endpoint ${endpoint}`,
							details: {}
						}
					});
				});
			}
		}), "dsh-ui-peak-rate: /peak-rate channel");
	});
}
/**
* Serve one Connection-RPC channel over a plain webServer route, mirroring
* dsh-client-connection's rpcFetchHandler semantics (POST-only, JSON
* client-request envelope, server-response envelope out) so the browser-side
* `connection.rpc.call()` keeps working unchanged.
*/
async function serveChannel(req, res, channel, handler) {
	const writeJson = (status, body) => {
		const bytes = Buffer.from(JSON.stringify(body));
		res.setHeader("Content-Type", "application/json; charset=utf-8");
		res.setHeader("Content-Length", String(bytes.length));
		res.writeHead(status);
		res.end(bytes);
	};
	const endpoint = endpointFromPath(channel, req.url ?? "/");
	if (req.method !== "POST" || endpoint === void 0) {
		res.writeHead(404);
		res.end("not found");
		return;
	}
	if (req.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") {
		res.writeHead(415);
		res.end("content type must be application/json");
		return;
	}
	let body;
	try {
		const chunks = [];
		for await (const chunk of req) {
			const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			chunks.push(part);
		}
		body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		res.writeHead(400);
		res.end("body is not JSON");
		return;
	}
	const message = body ?? {};
	const respond = (result) => writeJson(200, {
		type: "server-response",
		rpcId: typeof message.rpcId === "string" ? message.rpcId : "",
		result
	});
	if (typeof body !== "object" || body === null || message.type !== "client-request" || typeof message.rpcId !== "string" || typeof message.method !== "string") {
		respond({
			ok: false,
			error: {
				code: "gateway/bad-request",
				message: "invalid client-request message",
				details: {}
			}
		});
		return;
	}
	if (message.method !== endpoint) {
		respond({
			ok: false,
			error: {
				code: "gateway/bad-request",
				message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
				details: {}
			}
		});
		return;
	}
	const controller = new AbortController();
	req.once("aborted", () => controller.abort());
	req.socket.once("close", () => controller.abort());
	try {
		respond(await handler(endpoint, message.payload, controller.signal));
	} catch (error) {
		res.writeHead(500);
		res.end(`handler failure: ${String(error)}`);
	}
}
/** Extract and validate the endpoint segment below the channel prefix. */
function endpointFromPath(channel, pathname) {
	if (!pathname.startsWith(`${channel}/`)) return void 0;
	const endpoint = pathname.slice(channel.length + 1);
	if (endpoint.split("/").some((segment) => segment === "" || segment === "." || segment === ".." || !/^[A-Za-z0-9_$.-]+$/.test(segment))) return void 0;
	return endpoint;
}
//#endregion
export { Config, apply, inject, name };
