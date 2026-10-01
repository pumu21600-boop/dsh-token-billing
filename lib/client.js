/**
 * dsh-token-billing client half — extends the composer status bar (the
 * `conversation.composer.dock` slot, right below the chat input) with a live
 * cost readout, WITHOUT touching the existing "输入 X tok · 输出 Y tok" line.
 *
 *  - Settings section "Token 计费": ONLY configure prices — one row per model
 *    (model id + input / output / cached-input price per 1M tokens) plus the
 *    currency symbol. No manual "active model" selection.
 *  - The host half registers a `tokenUsageByModel` session projection that
 *    attributes each step's usage to the model that produced it (a
 *    conversation can switch models several times). The dock chip sums the
 *    priced models' cost; models WITHOUT a configured price default to
 *    0 yuan. Clicking it shows the per-model breakdown.
 *
 * Prices live in the host-owned settings namespace `token-billing` and are
 * read/written through the same-origin endpoint /dsh-token-billing/config
 * (settings.yaml on the host) — never localStorage, so they survive a
 * port/host change.
 */
window.__ModuleLoader__.load({
	id: "dsh-token-billing",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");
		const jsxRuntime = require("react/jsx-runtime");
		const { jsx, jsxs, Fragment } = jsxRuntime;
		const reactDom = require("react-dom");
		const createPortal = reactDom.createPortal;

		const NS = "token-billing";
		const CONFIG_URL = "/dsh-token-billing/config";
		function defaultState() {
			return {
				symbol: "¥",
				lastProvider: null,
				profiles: []
			};
		}
		function num(v) {
			const n = Number(v);
			return Number.isFinite(n) && n >= 0 ? n : 0;
		}
		/** Normalize a stored/host payload into the client's state shape. */
		function normalizeState(parsed) {
			if (!parsed || !Array.isArray(parsed.profiles)) return defaultState();
			return {
				symbol: typeof parsed.symbol === "string" && parsed.symbol !== "" ? parsed.symbol : "¥",
				lastProvider: typeof parsed.lastProvider === "string" && parsed.lastProvider !== "" ? parsed.lastProvider : null,
				profiles: parsed.profiles
					.filter((p) => p && typeof p.name === "string" && p.name !== "")
					.map((p) => ({
						name: p.name,
						provider: typeof p.provider === "string" && p.provider !== "" ? p.provider : null,
						input: num(p.input),
						output: num(p.output),
						cache: num(p.cache)
					}))
			};
		}
		/** Shared price state consumed by both the dock line and the settings form. */
		const store = (() => {
			let state = defaultState();
			const subs = /* @__PURE__ */ new Set();
			const emit = () => {
				for (const fn of [...subs]) fn();
			};
			return {
				getSnapshot: () => state,
				subscribe: (fn) => {
					subs.add(fn);
					return () => {
						subs.delete(fn);
					};
				},
				update: (next) => {
					state = next;
					emit();
					saveStore(next);
				},
				/** Adopt a host-provided snapshot WITHOUT writing it back. */
				hydrate: (next) => {
					state = next;
					emit();
				}
			};
		})();
		/* Writes are debounced so dragging a price field does not spam the host. */
		let saveTimer = null;
		function saveStore(next) {
			if (saveTimer !== null) clearTimeout(saveTimer);
			saveTimer = setTimeout(() => {
				saveTimer = null;
				try {
					fetch(CONFIG_URL, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ ...next, lastProvider: next.lastProvider ?? "" })
					}).catch(() => {});
				} catch {}
			}, 150);
		}
		/** Load the host-owned price table once at mount. */
		function hydrateStore() {
			(async () => {
				try {
					const r = await fetch(CONFIG_URL, { headers: { accept: "application/json" } });
					if (!r.ok) return;
					store.hydrate(normalizeState(await r.json()));
				} catch {}
			})();
		}
		/** Match a projected model against the configured price list:
		 *  1. exact (provider, model) pair on separate fields;
		 *  2. legacy combined name "provider::model";
		 *  3. bare model name — only as a last resort, and never preferred over
		 *     an exact provider match (prevents cross-provider price mixups). */
		function findProfile(profiles, provider, model) {
			if (provider !== null) {
				const exact = profiles.find((p) => p.provider === provider && p.name === model);
				if (exact) return exact;
			}
			const legacy = provider ? provider + "::" + model : null;
			if (legacy !== null) {
				const exact = profiles.find((p) => p.name === legacy);
				if (exact) return exact;
			}
			const bare = profiles.find((p) => p.name === model);
			if (bare) return bare;
			const lower = model.toLowerCase();
			return profiles.find((p) => p.name.toLowerCase() === lower) ?? null;
		}
		/** Split a projection key "provider::model" into its two parts. */
		function splitKey(key) {
			const i = key.indexOf("::");
			if (i > 0) return { provider: key.slice(0, i), model: key.slice(i + 2) };
			return { provider: null, model: key };
		}
		/** Default zero-yuan profile for models with no configured price. */
		const ZERO_PROFILE = { input: 0, output: 0, cache: 0 };
		/** Itemized cost for one model's buckets under one price profile. */
		function computeModel(provider, model, b, p) {
			const uncached = b.uncachedInputTokens ?? 0;
			const cacheRead = b.cacheReadTokens ?? 0;
			const cacheWrite = b.cacheWriteTokens ?? 0;
			const output = b.outputTokens ?? 0;
			const inputBilled = uncached + cacheWrite;
			return {
				provider,
				model,
				profile: p,
				uncached,
				cacheRead,
				cacheWrite,
				output,
				inputBilled,
				costInput: (inputBilled / 1e6) * p.input,
				costCache: (cacheRead / 1e6) * p.cache,
				costOutput: (output / 1e6) * p.output,
				total: ((inputBilled / 1e6) * p.input) + ((cacheRead / 1e6) * p.cache) + ((output / 1e6) * p.output)
			};
		}
		function fmtCost(v, symbol) {
			if (!Number.isFinite(v)) return symbol + "0";
			const s = v >= 1 ? v.toFixed(2) : v >= 0.01 ? v.toFixed(4) : v.toFixed(6);
			return symbol + s;
		}
		function fmtTokens(n) {
			if (n >= 1e9) return (n / 1e9).toFixed(2) + "B";
			if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
			if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
			return String(n);
		}
		const CSS_NS = "dshBilling";
		const css = `.${CSS_NS}_root{align-items:center;gap:6px;display:inline-flex}
.${CSS_NS}_chip{box-sizing:border-box;height:22px;cursor:pointer;color:var(--dsw-alias-label-secondary,#aab6d4);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.08));border:1px solid #525252;border-radius:11px;align-items:center;gap:5px;padding:0 10px;font-size:12px;line-height:18px;display:inline-flex;font-variant-numeric:tabular-nums}
.${CSS_NS}_chip:hover{color:var(--dsw-alias-label-primary,#e6ebf7);border-color:#d1d5db}
.${CSS_NS}_chip[data-open="true"]{color:var(--dsw-alias-label-primary,#e6ebf7);border-color:#d1d5db}
.${CSS_NS}_dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#4ade80);flex:none}
.${CSS_NS}_pop{position:fixed;z-index:2147483000;transform:translateY(-100%);width:340px;max-width:calc(100vw - 24px);max-height:70vh;overflow:auto;box-sizing:border-box;background:#1f1f1f;border:1px solid #4b5563;border-radius:12px;box-shadow:0 14px 44px rgba(0,0,0,.55);padding:12px 14px;color:#d1d5db;font:12px/1.6 -apple-system,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif}
.${CSS_NS}_head{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px}
.${CSS_NS}_name{font:600 13px/1.5 ui-monospace,Consolas,monospace;color:#f3f4f6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${CSS_NS}_total{font:600 15px/1.5 ui-monospace,Consolas,monospace;color:#f3f4f6;flex:none}
.${CSS_NS}_row{display:flex;align-items:baseline;gap:8px;padding:4px 0;border-top:1px solid #3f3f46}
.${CSS_NS}_k{flex:none;width:118px;color:#9ca3af;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.${CSS_NS}_tk{flex:none;min-width:56px;text-align:right;color:#d1d5db;font-variant-numeric:tabular-nums;font:11px/1.6 ui-monospace,Consolas,monospace}
.${CSS_NS}_cost{flex:1;text-align:right;color:#d1d5db;font-variant-numeric:tabular-nums;font:11px/1.6 ui-monospace,Consolas,monospace}
.${CSS_NS}_hint{color:#9ca3af;font-size:11px;margin-top:8px;border-top:1px solid #3f3f46;padding-top:6px}
.${CSS_NS}_noPrice{color:#9ca3af;font-size:12px}
.${CSS_NS}_model{border:1px solid #3f3f46;border-radius:10px;padding:8px 10px;margin-top:8px;flex-direction:column;display:flex}
.${CSS_NS}_modelHead{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:2px}
.${CSS_NS}_modelCost{font:600 13px/1.5 ui-monospace,Consolas,monospace;color:#f3f4f6;flex:none}
.${CSS_NS}_prov{color:#9ca3af;font-weight:400;font-size:11px}
.${CSS_NS}_provTag{color:inherit;opacity:.75;border:1px solid #525252;border-radius:4px;padding:1px 6px;font-size:11px;line-height:16px;flex:none;white-space:nowrap}
.${CSS_NS}_section{flex-direction:column;gap:12px;width:100%;display:flex}
.${CSS_NS}_section .${CSS_NS}_hint{margin-top:0;border-top:none;padding-top:0;color:inherit;opacity:.75;font-size:12px;line-height:18px}
.${CSS_NS}_symRow{align-items:center;gap:10px;display:flex}
.${CSS_NS}_lbl{color:inherit;opacity:.8;font-size:12px;line-height:18px}
.${CSS_NS}_inp{box-sizing:border-box;color:#e5e7eb;background:transparent;border:1px solid #525252;border-radius:9px;padding:6px 10px;font:inherit;font-size:13px;line-height:20px;outline:none}
.${CSS_NS}_inp:focus{border-color:#d1d5db}
.${CSS_NS}_sym{width:80px;flex:none}
.${CSS_NS}_card{border:1px solid #3f3f46;border-radius:12px;flex-direction:column;gap:10px;padding:10px 12px;display:flex}
.${CSS_NS}_cardHead{align-items:center;gap:8px;display:flex}
.${CSS_NS}_name{flex:1;min-width:0}
.${CSS_NS}_btn{box-sizing:border-box;height:30px;flex:none;cursor:pointer;color:#e5e7eb;background:transparent;border:1px solid #525252;border-radius:15px;padding:0 12px;font:inherit;font-size:12px;line-height:18px}
.${CSS_NS}_btn:hover{background:rgba(255,255,255,.08);border-color:#d1d5db}
.${CSS_NS}_btn:disabled{opacity:.5;cursor:default}
.${CSS_NS}_btnOn{color:#111111;background:#e5e7eb;border-color:#e5e7eb}
.${CSS_NS}_btnDel{color:#f87171}
.${CSS_NS}_status{color:inherit;opacity:.7;font-size:12px;line-height:18px}
.${CSS_NS}_statusErr{color:#f87171;font-size:12px;line-height:18px}
.${CSS_NS}_prices{display:flex;flex-wrap:wrap;gap:10px}
.${CSS_NS}_price{flex-direction:column;gap:4px;flex:1;min-width:120px;display:flex}
.${CSS_NS}_price .${CSS_NS}_inp{width:100%}
body:not([data-ds-dark-theme]) .${CSS_NS}_chip{border-color:#d1d5db}
body:not([data-ds-dark-theme]) .${CSS_NS}_chip:hover,body:not([data-ds-dark-theme]) .${CSS_NS}_chip[data-open="true"]{border-color:#9ca3af}
body:not([data-ds-dark-theme]) .${CSS_NS}_pop{background:#ffffff;border-color:#d1d5db;color:#374151}
body:not([data-ds-dark-theme]) .${CSS_NS}_name,body:not([data-ds-dark-theme]) .${CSS_NS}_total,body:not([data-ds-dark-theme]) .${CSS_NS}_modelCost{color:#111827}
body:not([data-ds-dark-theme]) .${CSS_NS}_row,body:not([data-ds-dark-theme]) .${CSS_NS}_hint{border-top-color:#e5e7eb}
body:not([data-ds-dark-theme]) .${CSS_NS}_k,body:not([data-ds-dark-theme]) .${CSS_NS}_hint,body:not([data-ds-dark-theme]) .${CSS_NS}_noPrice,body:not([data-ds-dark-theme]) .${CSS_NS}_prov{color:#6b7280}
body:not([data-ds-dark-theme]) .${CSS_NS}_tk,body:not([data-ds-dark-theme]) .${CSS_NS}_cost{color:#374151}
body:not([data-ds-dark-theme]) .${CSS_NS}_model,body:not([data-ds-dark-theme]) .${CSS_NS}_card{border-color:#e5e7eb}
body:not([data-ds-dark-theme]) .${CSS_NS}_provTag{border-color:#d1d5db}
body:not([data-ds-dark-theme]) .${CSS_NS}_inp,body:not([data-ds-dark-theme]) .${CSS_NS}_btn{color:#111827;border-color:#d1d5db}
body:not([data-ds-dark-theme]) .${CSS_NS}_inp:focus{border-color:#9ca3af}
body:not([data-ds-dark-theme]) .${CSS_NS}_btn:hover{background:#e5e7eb;border-color:#9ca3af}
body:not([data-ds-dark-theme]) .${CSS_NS}_btnOn{color:#ffffff;background:#374151;border-color:#374151}
body:not([data-ds-dark-theme]) .${CSS_NS}_btnDel,body:not([data-ds-dark-theme]) .${CSS_NS}_statusErr{color:#dc2626}`;
		const tagId = "dsh-token-billing/billing.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-token-billing";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		/** One click-to-open popover anchored below a chip; closes on outside click / Esc. */
		function usePopover() {
			const chipRef = react.useRef(null);
			const [open, setOpen] = react.useState(false);
			const [pos, setPos] = react.useState({ left: 0, top: 0 });
			react.useEffect(() => {
				if (!open) return;
				const onDocClick = (ev) => {
					if (chipRef.current && chipRef.current.contains(ev.target)) return;
					const pop = document.getElementById("dsh-billing-pop");
					if (pop && pop.contains(ev.target)) return;
					setOpen(false);
				};
				const onKey = (ev) => {
					if (ev.key === "Escape") setOpen(false);
				};
				document.addEventListener("click", onDocClick, true);
				document.addEventListener("keydown", onKey, true);
				return () => {
					document.removeEventListener("click", onDocClick, true);
					document.removeEventListener("keydown", onKey, true);
				};
			}, [open]);
			const toggle = () => {
				if (open) {
					setOpen(false);
					return;
				}
				const r = chipRef.current?.getBoundingClientRect();
				if (!r) return;
				// The composer sits at the bottom, so open ABOVE the chip
				// (translateY(-100%)) and clamp horizontally.
				const w = 340;
				let left = r.left;
				if (left + w > window.innerWidth - 8) left = Math.max(8, window.innerWidth - w - 8);
				setPos({ left, top: r.top - 6 });
				setOpen(true);
			};
			return { chipRef, open, pos, toggle, setOpen };
		}

		/**
		 * The composer-dock billing chip + details popover. Reads the
		 * `tokenUsageByModel` projection (usage attributed per model by the host
		 * half) and matches each model against the configured price list
		 * automatically — no manual model selection.
		 */
		function BillingLine({ useProjection, t }) {
			const byModel = useProjection("tokenUsageByModel");
			const aggregate = useProjection("tokenUsage");
			const snap = react.useSyncExternalStore(store.subscribe, store.getSnapshot);
			const { chipRef, open, pos, toggle } = usePopover();
			const rows = react.useMemo(() => {
				const map = byModel && byModel.byModel;
				if (map && Object.keys(map).length > 0) {
					return Object.entries(map)
						.sort(([a], [b]) => a.localeCompare(b))
						.map(([key, b]) => {
							const { provider, model } = splitKey(key);
							const p = findProfile(snap.profiles, provider, model);
							return computeModel(provider, model, b, p ?? ZERO_PROFILE);
						});
				}
				// Fallback for sessions without per-model data: one aggregate row.
				if (aggregate && (aggregate.uncachedInputTokens || aggregate.cacheReadTokens || aggregate.cacheWriteTokens || aggregate.outputTokens)) {
					return [computeModel(null, t("unknownModel"), aggregate, ZERO_PROFILE)];
				}
				return [];
			}, [byModel, aggregate, snap.profiles]);
			if (rows.length === 0) return null;
			const pricedTotal = rows.reduce((sum, r) => sum + (r.total ?? 0), 0);
			const pop = open
				? createPortal(jsxs("div", {
						id: "dsh-billing-pop",
						className: CSS_NS + "_pop",
						style: { left: pos.left + "px", top: pos.top + "px" },
						children: [
							jsxs("div", {
								className: CSS_NS + "_head",
								children: [
									jsx("div", { className: CSS_NS + "_name", children: t("pop.title") }),
									jsxs("div", {
										className: CSS_NS + "_total",
										children: [fmtCost(pricedTotal, snap.symbol)]
									})
								]
							}),
							rows.map((r) => jsxs("div", {
								key: (r.provider ? r.provider + "::" : "") + r.model,
								className: CSS_NS + "_model",
								children: [
									jsxs("div", {
										className: CSS_NS + "_modelHead",
										children: [
											jsxs("span", {
												className: CSS_NS + "_name",
												children: [
													r.provider && jsx("span", { className: CSS_NS + "_prov", children: r.provider + " / " }),
													r.model
												]
											}),
											jsx("span", { className: CSS_NS + "_modelCost", children: fmtCost(r.total, snap.symbol) })
										]
									}),
									jsxs("div", { className: CSS_NS + "_row", children: [
										jsx("span", { className: CSS_NS + "_k", children: t("row.input") }),
										jsx("span", { className: CSS_NS + "_tk", children: fmtTokens(r.inputBilled) }),
										jsx("span", { className: CSS_NS + "_cost", children: fmtCost(r.costInput, snap.symbol) })
									] }),
									jsxs("div", { className: CSS_NS + "_row", children: [
										jsx("span", { className: CSS_NS + "_k", children: t("row.output") }),
										jsx("span", { className: CSS_NS + "_tk", children: fmtTokens(r.output) }),
										jsx("span", { className: CSS_NS + "_cost", children: fmtCost(r.costOutput, snap.symbol) })
									] }),
									jsxs("div", { className: CSS_NS + "_row", children: [
										jsx("span", { className: CSS_NS + "_k", children: t("row.cacheRead") }),
										jsx("span", { className: CSS_NS + "_tk", children: fmtTokens(r.cacheRead) }),
										jsx("span", { className: CSS_NS + "_cost", children: fmtCost(r.costCache, snap.symbol) })
									] }),
									r.cacheWrite > 0 && jsxs("div", { className: CSS_NS + "_row", children: [
										jsx("span", { className: CSS_NS + "_k", children: t("row.cacheWrite") }),
										jsx("span", { className: CSS_NS + "_tk", children: fmtTokens(r.cacheWrite) }),
										jsx("span", { className: CSS_NS + "_cost", children: fmtCost((r.cacheWrite / 1e6) * r.profile.input, snap.symbol) })
									] })
								]
							})),
							jsx("div", { className: CSS_NS + "_hint", children: t("pop.hint") })
						]
					}), document.body)
				: null;
			return jsxs(Fragment, {
				children: [
					jsxs("button", {
						ref: chipRef,
						type: "button",
						"data-open": open ? "true" : void 0,
						className: CSS_NS + "_chip",
						onClick: toggle,
						children: [
							jsx("span", { className: CSS_NS + "_dot" }),
							jsx("span", { children: fmtCost(pricedTotal, snap.symbol) })
						]
					}),
					pop
				]
			});
		}

		/** Walk a settings path (array) into a namespace value. */
		function walkPath(obj, path) {
			let cur = obj;
			for (const k of path ?? []) {
				if (cur == null) return void 0;
				cur = cur[k];
			}
			return cur;
		}

		/**
		 * Settings form: pick an existing provider + model from the same catalog
		 * the models settings page uses, then set its prices. Changes sync to the
		 * billing card immediately (shared store).
		 */
		function PriceConfig({ t, api }) {
			const snap = react.useSyncExternalStore(store.subscribe, store.getSnapshot);
			const [catalog, setCatalog] = react.useState(null);
			const [catErr, setCatErr] = react.useState("");
			const [adding, setAdding] = react.useState(false);
			const [pickProvider, setPickProvider] = react.useState("");
			const [pickModel, setPickModel] = react.useState("");
			const [pickInput, setPickInput] = react.useState("");
			const [pickOutput, setPickOutput] = react.useState("");
			const [pickCache, setPickCache] = react.useState("");
			react.useEffect(() => {
				let dead = false;
				(async () => {
					try {
						/* DSH ≥ 0.2.0：llm/providers 已移除，改用 listConfigurableProviders
						   （value 直接是条目数组：provider / displayName / settingsNs / settingsPath）。 */
						const [provRes, setRes] = await Promise.all([api.llm.listConfigurableProviders(), api.settings.describe({})]);
						if (dead) return;
						if (!provRes.result.ok) {
							setCatErr("providers 接口返回失败：" + JSON.stringify(provRes.result.error));
							return;
						}
						const namespaces = new Map(setRes.result.value.namespaces.map((v) => [v.ns, v]));
						const declared = Array.isArray(provRes.result.value) ? provRes.result.value : (provRes.result.value.providers ?? []);
						const groups = declared
							.map((entry) => {
								const providerId = typeof entry.provider === "string" && entry.provider !== "" ? entry.provider : (entry.id ?? "");
								const ns = namespaces.get(entry.settingsNs);
								const value = ns !== void 0 ? walkPath(ns.value, entry.settingsPath) : void 0;
								const models = Array.isArray(value?.models)
									? value.models.map((m) => ({ id: m.id, name: typeof m.name === "string" && m.name !== "" ? m.name : m.id }))
									: [];
								return {
									id: providerId,
									display: typeof entry.displayName === "string" && entry.displayName !== "" ? entry.displayName : providerId,
									models
								};
							})
							.filter((g) => g.models.length > 0);
						setCatalog(groups);
					} catch (err) {
						if (!dead) setCatErr(String(err?.message ?? err));
					}
				})();
				return () => {
					dead = true;
				};
			}, [api]);
			const providerGroups = catalog ?? [];
			const currentGroup = providerGroups.find((g) => g.id === pickProvider) ?? null;
			const patchProfileAt = (idx, patch) => {
				store.update({
					...snap,
					profiles: snap.profiles.map((p, i) => (i === idx ? { ...p, ...patch } : p))
				});
			};
			const removeProfileAt = (idx) => {
				const profiles = snap.profiles.filter((_, i) => i !== idx);
				store.update({ ...snap, profiles });
			};
			const openPicker = () => {
				if (providerGroups.length === 0) {
					// Fallback when the catalog is unavailable: blank manual profile.
					let name = "新模型";
					let i = 2;
					while (snap.profiles.some((p) => p.name === name)) name = "新模型 " + i++;
					store.update({ ...snap, profiles: [...snap.profiles, { name, input: 0, output: 0, cache: 0 }] });
					return;
				}
				const first = providerGroups[0];
				// Default to the last-used provider when it is still available,
				// so a model added "right after" keeps its intended provider.
				const initial = providerGroups.some((g) => g.id === snap.lastProvider) ? snap.lastProvider : first.id;
				setPickProvider(initial);
				setPickModel(providerGroups.find((g) => g.id === initial)?.models[0]?.id ?? "");
				setPickInput("");
				setPickOutput("");
				setPickCache("");
				setAdding(true);
			};
			const confirmPick = () => {
				if (!currentGroup || pickModel === "") return;
				const priceProfile = { provider: currentGroup.id, input: num(pickInput), output: num(pickOutput), cache: num(pickCache) };
				// Same model under the SAME provider updates in place; the same model
				// id under a DIFFERENT provider is a separate billing row.
				const existingIdx = snap.profiles.findIndex((p) => p.name === pickModel && (p.provider ?? null) === currentGroup.id);
				const profiles = existingIdx >= 0
					? snap.profiles.map((p, i) => (i === existingIdx ? { ...p, ...priceProfile } : p))
					: [...snap.profiles, { name: pickModel, ...priceProfile }];
				store.update({ ...snap, lastProvider: currentGroup.id, profiles });
				setAdding(false);
			};
			return jsxs("div", {
				className: CSS_NS + "_section",
				children: [
					jsx("p", { className: CSS_NS + "_hint", children: t("settings.hint") }),
					catalog === null && catErr === "" && jsx("p", { className: CSS_NS + "_status", children: t("settings.loading") }),
					catalog !== null && catErr === "" && jsx("p", { className: CSS_NS + "_status", children: t("settings.catalogCount", { n: providerGroups.length }) }),
					catErr !== "" && jsx("p", { className: CSS_NS + "_statusErr", children: t("settings.loadError", { err: catErr }) }),
					jsx("div", {
						className: CSS_NS + "_symRow",
						children: [
							jsx("span", { className: CSS_NS + "_lbl", children: t("settings.symbol") }),
							jsx("input", {
								className: CSS_NS + "_inp " + CSS_NS + "_sym",
								value: snap.symbol,
								onChange: (e) => store.update({ ...snap, symbol: e.target.value })
							})
						]
					}),
					snap.profiles.map((p, idx) => jsxs("div", {
						key: (p.provider ? p.provider + "::" : "") + p.name,
						className: CSS_NS + "_card",
						children: [
							jsxs("div", {
								className: CSS_NS + "_cardHead",
								children: [
									jsx("input", {
										className: CSS_NS + "_inp " + CSS_NS + "_name",
										value: p.name,
										title: p.name,
										onChange: (e) => patchProfileAt(idx, { name: e.target.value })
									}),
									p.provider && jsx("span", { className: CSS_NS + "_provTag", children: p.provider }),
									jsx("button", {
										type: "button",
										className: CSS_NS + "_btn " + CSS_NS + "_btnDel",
										onClick: () => removeProfileAt(idx),
										children: t("settings.remove")
									})
								]
							}),
							jsxs("div", {
								className: CSS_NS + "_prices",
								children: [
									priceInput(t("settings.input"), p.input, (v) => patchProfileAt(idx, { input: v })),
									priceInput(t("settings.output"), p.output, (v) => patchProfileAt(idx, { output: v })),
									priceInput(t("settings.cache"), p.cache, (v) => patchProfileAt(idx, { cache: v }))
								]
							})
						]
					})),
					adding && jsxs("div", {
						className: CSS_NS + "_card",
						children: [
							jsx("div", { className: CSS_NS + "_lbl", children: t("settings.pickTitle") }),
							jsxs("div", {
								className: CSS_NS + "_prices",
								children: [
									jsxs("label", {
										className: CSS_NS + "_price",
										children: [
											jsx("span", { className: CSS_NS + "_lbl", children: t("settings.pickProvider") }),
											jsx("select", {
												className: CSS_NS + "_inp",
												value: pickProvider,
												onChange: (e) => {
													const g = providerGroups.find((x) => x.id === e.target.value);
													setPickProvider(e.target.value);
													setPickModel(g?.models[0]?.id ?? "");
													store.update({ ...snap, lastProvider: e.target.value });
												},
												children: providerGroups.length === 0
													? jsx("option", { value: "", children: t("settings.noProviders") })
													: providerGroups.map((g) => jsx("option", {
															key: g.id,
															value: g.id,
															children: g.display !== g.id ? `${g.display} (${g.id})` : g.id
														}))
											})
										]
									}),
									jsxs("label", {
										className: CSS_NS + "_price",
										children: [
											jsx("span", { className: CSS_NS + "_lbl", children: t("settings.pickModel") }),
											jsx("select", {
												className: CSS_NS + "_inp",
												value: pickModel,
												onChange: (e) => setPickModel(e.target.value),
												children: (currentGroup?.models ?? []).length === 0
													? jsx("option", { value: "", children: t("settings.noModels") })
													: (currentGroup?.models ?? []).map((m) => jsx("option", {
															key: m.id,
															value: m.id,
															children: m.name !== m.id ? `${m.name} (${m.id})` : m.id
														}))
											})
										]
									})
								]
							}),
							jsxs("div", {
								className: CSS_NS + "_prices",
								children: [
									pickPriceInput(t("settings.input"), pickInput, setPickInput),
									pickPriceInput(t("settings.output"), pickOutput, setPickOutput),
									pickPriceInput(t("settings.cache"), pickCache, setPickCache)
								]
							}),
							jsxs("div", {
								className: CSS_NS + "_symRow",
								children: [
									jsx("button", {
										type: "button",
										className: CSS_NS + "_btn " + CSS_NS + "_btnOn",
										disabled: pickModel === "",
										onClick: confirmPick,
										children: pickModel === ""
											? t("settings.pickConfirm")
											: `${t("settings.pickConfirm")}：${currentGroup?.id ?? "?"} / ${pickModel}`
									}),
									jsx("button", {
										type: "button",
										className: CSS_NS + "_btn",
										onClick: () => setAdding(false),
										children: t("settings.pickCancel")
									})
								]
							})
						]
					}),
					!adding && jsx("button", {
						type: "button",
						className: CSS_NS + "_btn",
						onClick: openPicker,
						children: t("settings.add")
					})
				]
			});
		}
		function pickPriceInput(label, value, onChange) {
			return jsxs("label", {
				className: CSS_NS + "_price",
				children: [
					jsx("span", { className: CSS_NS + "_lbl", children: label }),
					jsx("input", {
						className: CSS_NS + "_inp",
						type: "number",
						min: "0",
						step: "0.01",
						placeholder: "0",
						value: value,
						onChange: (e) => onChange(e.target.value)
					})
				]
			});
		}
		function priceInput(label, value, onChange) {
			return jsxs("label", {
				className: CSS_NS + "_price",
				children: [
					jsx("span", { className: CSS_NS + "_lbl", children: label }),
					jsx("input", {
						className: CSS_NS + "_inp",
						type: "number",
						min: "0",
						step: "0.01",
						value: value,
						onChange: (e) => onChange(num(e.target.value))
					})
				]
			});
		}

		const zh = {
			"nav": "Token 计费",
			"pop.title": "按模型消耗",
			"row.input": "输入（不含缓存）",
			"row.output": "输出",
			"row.cacheRead": "缓存输入",
			"row.cacheWrite": "缓存写（按输入价）",
			"unknownModel": "未识别模型",
			"pop.hint": "工具自动按对话中实际使用的模型匹配价格；未设置价格的模型默认按 0 元计费。在 设置 → Token 计费 里为每个模型填写价格（模型名需与模型 id 一致）。",
			"settings.hint": "这里只填模型 id 和价格（每百万 token 计费）：输入价、输出价、缓存输入价。未设置价格的模型默认按 0 元计费。对话中切换过几个模型，工具就会自动按「供应商 / 模型」分别统计并各自计费；想给同一模型在不同供应商下分开计价，可把名称写成 供应商::模型（如 tokeness::deepseek-v4-pro）。",
			"settings.symbol": "货币符号",
			"settings.remove": "删除",
			"settings.add": "+ 添加模型",
			"settings.pickTitle": "从已有供应商里选择要定价的模型",
			"settings.pickProvider": "供应商",
			"settings.pickModel": "模型",
			"settings.pickConfirm": "加入计费",
			"settings.pickCancel": "取消",
			"settings.loading": "正在加载供应商目录…",
			"settings.catalogCount": "已加载 {n} 个供应商（含可用模型）",
			"settings.loadError": "供应商目录加载失败：{err}",
			"settings.noModels": "— 无可用模型 —",
			"settings.noProviders": "— 无可用供应商 —",
			"settings.input": "输入价",
			"settings.output": "输出价",
			"settings.cache": "缓存输入价"
		};
		const en = {
			"nav": "Token Billing",
			"pop.title": "Consumption by model",
			"row.input": "Input (excl. cache)",
			"row.output": "Output",
			"row.cacheRead": "Cache input",
			"row.cacheWrite": "Cache write (input rate)",
			"unknownModel": "Unrecognized model",
			"pop.hint": "Usage is attributed to the model that produced it and matched to your prices automatically. Models without a configured price bill at 0. Configure per-model prices under Settings → Token Billing.",
			"settings.hint": "Enter model ids and per-1M-token prices only: input, output, cache-read. Models without a configured price bill at 0. Every model used in the conversation is tracked and billed separately, automatically.",
			"settings.symbol": "Currency",
			"settings.remove": "Remove",
			"settings.add": "+ Add model",
			"settings.pickTitle": "Pick a model from an existing provider to price",
			"settings.pickProvider": "Provider",
			"settings.pickModel": "Model",
			"settings.pickConfirm": "Add to billing",
			"settings.pickCancel": "Cancel",
			"settings.loading": "Loading provider catalog…",
			"settings.catalogCount": "{n} providers with usable models loaded",
			"settings.loadError": "Provider catalog failed to load: {err}",
			"settings.noModels": "— no usable models —",
			"settings.noProviders": "— no usable providers —",
			"settings.input": "Input",
			"settings.output": "Output",
			"settings.cache": "Cache input"
		};

		const inject = ["slots", "locale", "connection"];
		/**
		 * Register dictionaries, the pricing settings section, and the
		 * composer-dock billing line (order 1, after the stock stats line).
		 */
		function apply(ctx) {
			/* Adopt the host-owned price table (settings namespace `token-billing`). */
			ctx.effect(() => {
				hydrateStore();
				return () => {};
			}, "dsh-token-billing: hydrate");
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "dsh-token-billing: dict");
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "token-billing",
				order: 102,
				label: () => t("nav"),
				locale: NS,
				inject: () => ({ api: ctx.connection.api })
			}, PriceConfig));
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "billing",
				order: 1,
				locale: NS
			}, BillingLine));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
