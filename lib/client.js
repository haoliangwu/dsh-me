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
		const CHANNEL = "/peak-rate";
		/** Endpoint under {@link CHANNEL} returning the configured peak-rate policy. */
		const ENDPOINT_CONFIG = "config";
		/** Required services: the contribution registry, locale, the model directory, and the Connection RPC carrier. */
		const inject = [
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
		function apply(ctx) {
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
				const result = await ctx.connection.rpc.call(CHANNEL, ENDPOINT_CONFIG, {});
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
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map