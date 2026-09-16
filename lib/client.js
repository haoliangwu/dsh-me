window.__ModuleLoader__.load({
	id: "dsh-me",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/plugins/peak-rate/client/peak-rate.ts
		/**
		* Whether a UTC moment falls in a peak-rate window.
		*
		* Windows are `[startHour, endHour)` UTC hour pairs, left-closed right-open.
		* An empty window list is always off-peak.
		* @param date - the moment to test.
		* @param windows - peak windows as `[startHour, endHour)` UTC hour pairs.
		* @returns true iff the date's UTC hour is in a peak window.
		*/
		function isPeak(date, windows) {
			const hour = date.getUTCHours();
			return windows.some(([start, end]) => hour >= start && hour < end);
		}
		/**
		* Whether the Beijing-time calendar day of a UTC moment is a weekend
		* (Saturday or Sunday).
		*
		* The billing rule is stated in Beijing time, so the weekend boundary follows
		* the UTC+8 calendar date: Beijing Saturday 00:00 is UTC Friday 16:00 and
		* Beijing Monday 00:00 is UTC Sunday 16:00, both of which a plain UTC
		* `getUTCDay()` weekend check would get wrong by half a day.
		* @param date - the moment to test.
		* @returns true iff the moment falls on a Beijing-time Saturday or Sunday.
		*/
		function isWeekend(date) {
			const beijingDay = new Date(date.getTime() + 288e5).getUTCDay();
			return beijingDay === 0 || beijingDay === 6;
		}
		/**
		* Whether a moment is charged at the peak rate under the current billing
		* rule: weekdays follow the configured peak windows; weekends (Beijing time)
		* are all-day off-peak per the rule change effective 2026-08-23.
		* @param date - the moment to test.
		* @param windows - peak windows as `[startHour, endHour)` UTC hour pairs.
		* @returns true iff the date is a weekday inside a peak window.
		*/
		function isPeakRate(date, windows) {
			return !isWeekend(date) && isPeak(date, windows);
		}
		/**
		* Format peak windows as a locale-independent string, e.g. `01:00–04:00, 06:00–10:00`.
		* @param windows - peak windows as `[startHour, endHour)` UTC hour pairs.
		* @returns two-digit zero-padded `HH:00–HH:00` pairs joined by `, `.
		*/
		function formatWindows(windows) {
			const pad = (n) => n.toString().padStart(2, "0");
			return windows.map(([start, end]) => `${pad(start)}:00–${pad(end)}:00`).join(", ");
		}
		//#endregion
		//#region \0dsh-css:/Users/haoliang.wu/lyon/learn/dsh/dsh-me/src/plugins/peak-rate/client/PeakRateBadge.module.css.mjs
		const css = "._58UX_a_badge{background:var(--dsw-alias-state-warn-tertiary);color:var(--dsw-alias-state-warn-label);white-space:nowrap;cursor:default;user-select:none;border-radius:999px;flex:none;align-items:center;gap:4px;padding:2px 8px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}";
		const tagId = "dsh-me/PeakRateBadge.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-me";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var PeakRateBadge_module_css_default = { "badge": "_58UX_a_badge" };
		//#endregion
		//#region src/plugins/peak-rate/client/PeakRateBadge.tsx
		/** How often the peak/off-peak window re-evaluates, in milliseconds. */
		const REFRESH_INTERVAL_MS = 6e4;
		/** Lowercased substring a model id must contain to match the DeepSeek peak-rate policy on its own. */
		const MODEL_ID_MARKER = "deepseek";
		/**
		* Render the peak-rate badge, or null when off-peak / unmatched selection / no current model.
		* @param props - shared directory store, config source, and locale seat.
		* @returns the 🔥 {multiplier}× pill, or null when the badge is hidden.
		*/
		function PeakRateBadge({ directory, config, t }) {
			const state = (0, react.useSyncExternalStore)((fn) => directory.subscribe(fn), () => directory.getSnapshot());
			const policy = (0, react.useSyncExternalStore)((fn) => config.subscribe(fn), () => config.getSnapshot());
			const [peak, setPeak] = (0, react.useState)(() => isPeakRate(/* @__PURE__ */ new Date(), policy.peakWindows));
			(0, react.useEffect)(() => {
				setPeak(isPeakRate(/* @__PURE__ */ new Date(), policy.peakWindows));
				const id = setInterval(() => {
					setPeak(isPeakRate(/* @__PURE__ */ new Date(), policy.peakWindows));
				}, REFRESH_INTERVAL_MS);
				return () => {
					clearInterval(id);
				};
			}, [policy.peakWindows]);
			if (state.current === null) return null;
			const { provider, model } = state.current;
			const providerMatch = policy.providers.includes(provider);
			const modelMatch = model.toLowerCase().includes(MODEL_ID_MARKER);
			if (!(providerMatch && modelMatch)) return null;
			if (!peak) return null;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
				className: PeakRateBadge_module_css_default.badge,
				title: t("title", {
					multiplier: policy.multiplier,
					windows: formatWindows(policy.peakWindows)
				}),
				children: t("badge", { multiplier: policy.multiplier })
			});
		}
		//#endregion
		//#region src/plugins/peak-rate/client/locales.ts
		/** `peak` namespace dictionaries. */
		/** Simplified Chinese dictionary (the key-set source of truth). */
		const zh = {
			"badge": "🔥 {multiplier}×",
			"title": "高峰时段 · 费用为低峰的 {multiplier}× ({windows} UTC)"
		};
		/** English dictionary mirroring the Chinese key set. */
		const en = {
			"badge": "🔥 {multiplier}×",
			"title": "Peak hours · {multiplier}× off-peak rate ({windows} UTC)"
		};
		//#endregion
		//#region src/plugins/peak-rate/client/index.ts
		/** Dictionary namespace owned by this plugin. */
		const NS = "peak";
		/** RPC channel owned by the host half of this plugin. */
		const CHANNEL$1 = "/peak-rate";
		/** Endpoint under {@link CHANNEL} returning the configured peak-rate policy. */
		const ENDPOINT_CONFIG$1 = "config";
		/** Required services: the contribution registry, locale, the model directory, and the Connection RPC carrier. */
		const inject$2 = [
			"slots",
			"locale",
			"modelDirectories",
			"connection",
			"remote.session"
		];
		/**
		* Client plugin body: register the `peak` dictionaries and the composer's
		* trailing input-slot entry. Fetch the configured peak-rate policy once from
		* the host half through the Connection RPC channel; the badge stays hidden
		* until the fetch settles.
		* @param ctx - client root context.
		*/
		function apply$2(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "client-ui-peak-rate: dictionaries");
			let policy = {
				providers: [],
				peakWindows: [],
				multiplier: 0
			};
			const listeners = /* @__PURE__ */ new Set();
			const configSource = {
				getSnapshot: () => policy,
				subscribe: (listener) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				}
			};
			const publish = (next) => {
				if (Object.is(next, policy)) return;
				policy = next;
				for (const listener of [...listeners]) listener();
			};
			ctx.effect(async () => {
				const result = await ctx.connection.rpc.call(CHANNEL$1, ENDPOINT_CONFIG$1, {});
				if (result.ok) publish(result.value);
			}, "client-ui-peak-rate: fetch config");
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "dsh-ui-peak-rate",
				locale: NS,
				inject: (sessionId) => ({
					directory: ctx.modelDirectories.directoryFor(sessionId).store,
					config: configSource
				})
			}, PeakRateBadge));
		}
		//#endregion
		//#region src/plugins/notification/client/notification.ts
		/** Appended when `max-tokens` ended the turn (spec: 正文注明截断). */
		const TRUNCATION_NOTE = "（已达 max-tokens，输出被截断）";
		/**
		* Map a `turn/end` reason to a notification outcome per the spec:
		* `error` → error notification (body = reason.error.message),
		* `completed` → completion, `max-tokens` → completion with truncation note,
		* `aborted` / `blocked` / `interrupted` (and unknown merge-extensible kinds)
		* → nothing.
		* @param reason - the `turn/end` reason payload.
		* @returns the outcome, or null when the reason must not notify.
		*/
		function turnEndOutcome(reason) {
			switch (reason?.kind) {
				case "completed": return {
					type: "completion",
					truncated: false
				};
				case "max-tokens": return {
					type: "completion",
					truncated: true
				};
				case "error": return {
					type: "error",
					message: reason.error?.message ?? "LLM 调用失败"
				};
				default: return null;
			}
		}
		/**
		* The visibility gate (spec: 仅 `document.visibilityState !== 'visible'` 时弹)
		* combined with the trigger's config toggle.
		* @param visibility - the document visibility state.
		* @param enabled - the config toggle for this trigger type.
		* @returns true iff a notification may fire.
		*/
		function shouldNotify(visibility, enabled) {
			return enabled && visibility !== "visible";
		}
		/**
		* Code-point-safe truncation: the first `max` code points, ellipsized once
		* cut. Never splits surrogate pairs.
		* @param text - the text to bound.
		* @param max - the maximum length in code points.
		* @returns the bounded text.
		*/
		function truncate(text, max = 200) {
			if (text.length <= max) return text;
			return `${Array.from(text).slice(0, max).join("")}…`;
		}
		/**
		* Plain-text join of the final `assistant/message` of one turn's `content`
		* text blocks (spec: 最后回复前 ~200 字; simple text-chunk join is fine).
		* @param entries - the event window entries.
		* @param turn - the closed turn number.
		* @returns the turn's final assistant text, or '' when none.
		*/
		function assistantTurnText(entries, turn) {
			for (let index = entries.length - 1; index >= 0; index -= 1) {
				const entry = entries[index];
				if (entry.type !== "event" || entry.event.type !== "assistant/message") continue;
				const data = entry.event.data;
				if (data?.turn !== turn) continue;
				return (Array.isArray(data.message?.content) ? data.message.content : []).filter((block) => {
					if (typeof block !== "object" || block === null) return false;
					const candidate = block;
					return candidate.type === "text" && typeof candidate.text === "string";
				}).map((block) => block.text).join(" ").trim();
			}
			return "";
		}
		/**
		* Assemble a turn/end notification body: error message verbatim, completion
		* text truncated to ~200 code points with the truncation note appended when
		* the turn hit `max-tokens`.
		* @param outcome - the mapped turn/end outcome.
		* @param text - the turn's final assistant text (raw, unbounded).
		* @returns the notification body.
		*/
		function bodyForTurnEnd(outcome, text) {
			if (outcome.type === "error") return outcome.message;
			const body = truncate(text);
			if (!outcome.truncated) return body;
			return body === "" ? TRUNCATION_NOTE : `${body} ${TRUNCATION_NOTE}`;
		}
		/**
		* Question notification body: the questions' texts joined by ` / `.
		* @param items - the request's question items.
		* @returns the body, or '' when no question text exists.
		*/
		function questionBody(items) {
			return items.map((item) => item.question).filter((question) => typeof question === "string" && question !== "").join(" / ");
		}
		/**
		* Notification title: type marker + session name (spec).
		* @param kind - the trigger type.
		* @param sessionName - the session's display title.
		* @returns the title.
		*/
		function titleFor(kind, sessionName) {
			return `[dsh] ${kind === "completion" ? "完成" : kind === "error" ? "错误" : "提问"}：${sessionName}`;
		}
		/**
		* Diff a pending-interactions snapshot against the already-handled keys:
		* every not-yet-seen key is reported for marking, and among those, entries of
		* the question domains (`question` / `plan-review`) become notification
		* candidates. Unknown kinds are marked seen without firing — a later snapshot
		* must never re-deliver them. Keys absent from the previous run re-fire only
		* on a genuinely new key.
		* @param seen - keys already handled (index seeds this from the startup snapshot).
		* @param snapshot - the current pending-interactions map (keyed by session id).
		* @returns keys to mark seen and the question notifications to fire.
		*/
		function pendingQuestionNotifications(seen, snapshot) {
			const keys = [];
			const fired = [];
			for (const interaction of snapshot.values()) {
				if (seen.has(interaction.key)) continue;
				keys.push(interaction.key);
				if (interaction.kind !== "question" && interaction.kind !== "plan-review") continue;
				fired.push({
					sessionId: interaction.sessionId,
					questions: interaction.questions ?? []
				});
			}
			return {
				keys,
				fired
			};
		}
		/**
		* Synthesize the two-tone notification chime on a Web Audio graph: sine tone A
		* (880 Hz) over `at`..`at+0.09`, tone B (1174.66 Hz, D6) over
		* `at+0.10`..`at+0.19`, each with a 10 ms attack and exponential decay to
		* silence. Pure over the context-like so the scheduling is unit-testable.
		* @param ac - the (real or fake) audio context.
		* @param at - the chime's start in context seconds (defaults to now).
		*/
		function playChime(ac, at = ac.currentTime) {
			const tone = (frequency, start, end) => {
				const oscillator = ac.createOscillator();
				oscillator.frequency.value = frequency;
				const gain = ac.createGain();
				gain.connect(ac.destination);
				oscillator.connect(gain);
				gain.gain.setValueAtTime(1e-4, start);
				gain.gain.exponentialRampToValueAtTime(.18, start + .01);
				gain.gain.exponentialRampToValueAtTime(1e-4, end);
				oscillator.start(start);
				oscillator.stop(end);
			};
			tone(880, at, at + .09);
			tone(1174.66, at + .1, at + .19);
		}
		//#endregion
		//#region src/plugins/notification/client/index.ts
		/** RPC channel owned by the host half of this plugin. */
		const CHANNEL = "/notification";
		/** Endpoint under {@link CHANNEL} returning the configured trigger toggles. */
		const ENDPOINT_CONFIG = "config";
		/** Default toggles while the host fetch is in flight or absent. */
		const DEFAULT_CONFIG = {
			notifyCompletion: true,
			notifyError: true,
			notifyQuestion: true,
			notifySound: true
		};
		/** Required services: the Connection RPC carrier, the sessions mirror, and the pending-interaction publisher. */
		const inject$1 = [
			"connection",
			"sessions",
			"uiSession"
		];
		/**
		* Client plugin body: fetch trigger toggles once, watch every mirrored
		* session's event window for `turn/end`, and diff `uiSession
		* .pendingInteractions` for new questions. All subscriptions are
		* effect-scoped disposers.
		* @param ctx - client root context.
		*/
		function apply$1(ctx) {
			const scoped = ctx;
			const logger = ctx.logger;
			let config = { ...DEFAULT_CONFIG };
			ctx.effect(async () => {
				try {
					const result = await scoped.connection.rpc.call(CHANNEL, ENDPOINT_CONFIG, {});
					if (result.ok && typeof result.value === "object" && result.value !== null) config = {
						notifyCompletion: result.value.notifyCompletion ?? config.notifyCompletion,
						notifyError: result.value.notifyError ?? config.notifyError,
						notifyQuestion: result.value.notifyQuestion ?? config.notifyQuestion,
						notifySound: result.value.notifySound ?? config.notifySound
					};
				} catch (error) {
					logger.warn("dsh-ui-notification: config fetch failed, using defaults", error);
				}
			}, "dsh-ui-notification: fetch config");
			let permission = "unrequested";
			const notify = (title, body) => {
				notifyWithApi(title, body, config.notifySound, () => permission, (state) => {
					permission = state;
				});
			};
			const fire = (type, title, body) => {
				const enabled = type === "error" ? config.notifyError : config.notifyCompletion;
				if (shouldNotify(document.visibilityState, enabled)) notify(title, body);
			};
			const watched = /* @__PURE__ */ new Map();
			const onWindowChange = (sessionId, snapshot) => {
				if (snapshot.change.kind !== "append" || snapshot.change.entries === void 0) return;
				for (const entry of snapshot.change.entries) {
					if (entry.type !== "event" || entry.event.type !== "turn/end") continue;
					const data = entry.event.data;
					if (typeof data?.turn !== "number" || data.reason === void 0) continue;
					const outcome = turnEndOutcome(data.reason);
					if (outcome === null) continue;
					const name = sessionName(sessionId);
					if (outcome.type === "error") fire("error", titleFor("error", name), outcome.message);
					else {
						const body = bodyForTurnEnd(outcome, assistantTurnText(snapshot.entries, data.turn));
						fire("completion", titleFor("completion", name), body);
					}
				}
			};
			const reconcileSessions = () => {
				const snapshot = scoped.sessions.list.getSnapshot();
				const ids = new Set(snapshot.ids);
				for (const [id, watcher] of watched) if (!ids.has(id)) {
					watcher.dispose();
					watched.delete(id);
				}
				for (const id of snapshot.ids) {
					if (watched.has(id)) continue;
					const binding = scoped.sessions.binding(id);
					if (binding === void 0) continue;
					const dispose = binding.eventSource.subscribe(() => {
						onWindowChange(binding.sessionId, binding.eventSource.getSnapshot());
					});
					watched.set(id, { dispose });
				}
			};
			ctx.effect(() => {
				const dispose = scoped.sessions.list.subscribe(reconcileSessions);
				reconcileSessions();
				return dispose;
			}, "dsh-ui-notification: watch mirrored sessions");
			let seenKeys = /* @__PURE__ */ new Set();
			const reconcileQuestions = () => {
				const { keys, fired } = pendingQuestionNotifications(seenKeys, scoped.uiSession.pendingInteractions.getSnapshot());
				if (keys.length > 0) seenKeys = /* @__PURE__ */ new Set([...seenKeys, ...keys]);
				for (const item of fired) {
					if (!shouldNotify(document.visibilityState, config.notifyQuestion)) continue;
					notify(titleFor("question", sessionName(item.sessionId)), questionBody(item.questions));
				}
			};
			ctx.effect(() => {
				const initial = scoped.uiSession.pendingInteractions.getSnapshot();
				seenKeys = new Set([...initial.values()].map((interaction) => interaction.key));
				return scoped.uiSession.pendingInteractions.subscribe(reconcileQuestions);
			}, "dsh-ui-notification: watch pending interactions");
			function sessionName(sessionId) {
				return scoped.sessions.list.getSnapshot().byId[sessionId]?.displayTitle ?? sessionId;
			}
		}
		/**
		* Request Notification permission lazily and emit once granted; every other
		* state (denied, already requesting, unsupported browser) stays silent. The
		* OS default sound is suppressed (`silent: true`); when `sound` is set the
		* synthesized chime replaces it.
		* @param title - the notification title.
		* @param body - the notification body.
		* @param sound - whether to play the synthesized chime on emit.
		* @param readState - current permission state reader (test seam).
		* @param writeState - permission state writer (test seam).
		*/
		async function notifyWithApi(title, body, sound, readState, writeState) {
			const Api = globalThis.Notification;
			if (Api === void 0 || typeof Api.requestPermission !== "function") return;
			const emit = () => {
				const notification = new Api(title, {
					body,
					silent: true
				});
				notification.onclick = () => {
					globalThis.focus();
					notification.close();
				};
				if (sound) chimeSound();
			};
			const current = readState();
			if (current === "granted") {
				emit();
				return;
			}
			if (current !== "unrequested") return;
			writeState("requesting");
			try {
				const state = await Api.requestPermission();
				writeState(state === "granted" ? "granted" : "denied");
				if (state === "granted") emit();
			} catch {
				writeState("denied");
			}
		}
		/** Lazy singleton audio context (browser half, one page lifetime). */
		let chimeAudioContext;
		/**
		* Play the synthesized chime: acquire the real AudioContext once per page,
		* resume it (autoplay-policy: the user has interacted with dsh before any
		* notification fires, so this normally resolves; a failure just stays silent)
		* and schedule the two tones.
		*/
		function chimeSound() {
			const Ctor = globalThis.AudioContext;
			if (Ctor === void 0) return;
			if (chimeAudioContext === void 0) chimeAudioContext = new Ctor();
			chimeAudioContext.resume().catch(() => {});
			playChime(chimeAudioContext);
		}
		//#endregion
		//#region src/client/index.ts
		/** Required services: the union of every aggregated client half. */
		const inject = [.../* @__PURE__ */ new Set([...inject$2, ...inject$1])];
		/**
		* Apply every aggregated client half against the one merged bundle context.
		* @param ctx - client root context.
		*/
		function apply(ctx) {
			apply$2(ctx);
			apply$1(ctx);
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map