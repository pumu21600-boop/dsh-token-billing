/**
 * dsh-token-billing host half.
 *
 * 1) Registers the per-model token-usage session projection. A conversation
 *    may switch models several times; each `assistant/message` event carries
 *    its step's usage AND the producing model's identity
 *    (message.source.model), so the projection folds usage per model
 *    (replace-per-step, last wins on retries) and exposes
 *    `{ byModel, totals }` to the client through
 *    useProjection("tokenUsageByModel").
 * 2) Owns the price table: settings namespace `token-billing` (persisted by
 *    the official host settings provider into settings.yaml) plus the
 *    same-origin endpoints `/dsh-token-billing/config` (GET/POST) the client
 *    half reads and writes. The table never touches localStorage, so it
 *    survives a port/host change.
 */
import z from "zod";
import sm from "@deepseek-ai/schemastery";

const bucketsSchema = z.object({
	uncachedInputTokens: z.number().int().nonnegative(),
	outputTokens: z.number().int().nonnegative(),
	cacheReadTokens: z.number().int().nonnegative(),
	cacheWriteTokens: z.number().int().nonnegative()
}).strict();

const viewSchema = z.object({
	byModel: z.record(bucketsSchema),
	totals: bucketsSchema
}).strict();

const lastSchema = z.object({
	turn: z.number().int().nonnegative(),
	step: z.number().int().nonnegative(),
	key: z.string(),
	uncachedInputTokens: z.number().int().nonnegative(),
	outputTokens: z.number().int().nonnegative(),
	cacheReadTokens: z.number().int().nonnegative(),
	cacheWriteTokens: z.number().int().nonnegative()
}).strict();

const stateSchema = z.object({
	byModel: z.record(bucketsSchema),
	last: lastSchema.nullable()
}).strict();

const zero = () => ({
	uncachedInputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0
});
const add = (a, b) => ({
	uncachedInputTokens: a.uncachedInputTokens + b.uncachedInputTokens,
	outputTokens: a.outputTokens + b.outputTokens,
	cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
	cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens
});
const sub = (a, b) => ({
	uncachedInputTokens: a.uncachedInputTokens - b.uncachedInputTokens,
	outputTokens: a.outputTokens - b.outputTokens,
	cacheReadTokens: a.cacheReadTokens - b.cacheReadTokens,
	cacheWriteTokens: a.cacheWriteTokens - b.cacheWriteTokens
});
const isZero = (b) => b.uncachedInputTokens === 0 && b.outputTokens === 0 && b.cacheReadTokens === 0 && b.cacheWriteTokens === 0;

const tokenUsageByModelProjection = {
	key: "tokenUsageByModel",
	stateSchema,
	init: () => ({ byModel: {}, last: null }),
	apply: (state, event) => {
		if (event.type !== "assistant/message" || event.data.usage === void 0) return state;
		const { turn, step, usage } = event.data;
		const src = event.data.message && event.data.message.source;
		const model = src && typeof src.model === "string" && src.model !== "" ? src.model : null;
		if (model === null) return state;
		const provider = src && typeof src.provider === "string" && src.provider !== "" ? src.provider : null;
		// Composite key so the same model id under different providers never mixes.
		const key = provider !== null ? provider + "::" + model : model;
		const buckets = {
			uncachedInputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cacheReadTokens: usage.cacheReadTokens ?? 0,
			cacheWriteTokens: usage.cacheWriteTokens ?? 0
		};
		// Replace-per-step: a repeated sample for the same turn/step (retry,
		// late usage chunk) replaces the earlier value instead of double counting.
		const prev = state.last !== null && state.last.turn === turn && state.last.step === step ? state.last : null;
		const byModel = { ...state.byModel };
		if (prev !== null) {
			const cur = sub(byModel[prev.key] ?? zero(), prev);
			if (isZero(cur)) delete byModel[prev.key];
			else byModel[prev.key] = cur;
		}
		const next = add(byModel[key] ?? zero(), buckets);
		if (isZero(next)) delete byModel[key];
		else byModel[key] = next;
		return { byModel, last: { turn, step, key, ...buckets } };
	},
	wire: {
		viewSchema,
		view: (state) => {
			const totals = zero();
			for (const b of Object.values(state.byModel)) {
				totals.uncachedInputTokens += b.uncachedInputTokens;
				totals.outputTokens += b.outputTokens;
				totals.cacheReadTokens += b.cacheReadTokens;
				totals.cacheWriteTokens += b.cacheWriteTokens;
			}
			return { byModel: state.byModel, totals };
		}
	},
	stateVersion: 2
};

/* ── price settings (§2) ────────────────────────────────────────────── */

/** One model price row; `provider` empty means "any provider". */
const priceRow = sm.object({
	name: sm.string().required(),
	provider: sm.string().default(""),
	input: sm.number().min(0).default(0),
	output: sm.number().min(0).default(0),
	cache: sm.number().min(0).default(0),
});

const settingsSchema = sm.object({
	symbol: sm.string().default("¥"),
	lastProvider: sm.string().default(""),
	profiles: sm.array(priceRow).default([]),
});

/** DSH ≥ 0.2.0:条目配置 schema,由 cordis loader 校验并驱动设置表单。 */
export const Config = settingsSchema;

function sendJson(res, status, payload) {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on("data", (c) => chunks.push(c));
		req.on("end", () => {
			try {
				const raw = Buffer.concat(chunks).toString("utf8");
				resolve(raw ? JSON.parse(raw) : {});
			} catch (err) {
				reject(err);
			}
		});
		req.on("error", reject);
	});
}

/** Normalize any stored/client payload into the settings shape. */
function normalizeConfig(raw) {
	const src = raw && typeof raw === "object" ? raw : {};
	const rows = Array.isArray(src.profiles) ? src.profiles : [];
	return {
		symbol: typeof src.symbol === "string" && src.symbol !== "" ? src.symbol : "¥",
		lastProvider: typeof src.lastProvider === "string" ? src.lastProvider : "",
		profiles: rows
			.filter((p) => p && typeof p.name === "string" && p.name !== "")
			.map((p) => ({
				name: p.name,
				provider: typeof p.provider === "string" ? p.provider : "",
				input: Number.isFinite(Number(p.input)) && Number(p.input) >= 0 ? Number(p.input) : 0,
				output: Number.isFinite(Number(p.output)) && Number(p.output) >= 0 ? Number(p.output) : 0,
				cache: Number.isFinite(Number(p.cache)) && Number(p.cache) >= 0 ? Number(p.cache) : 0,
			})),
	};
}

/** Required services: configEditor persists the price table into the profile. */
export const inject = ["configEditor", "settings", "webServer"];

export function apply(ctx, config) {
	/* 自定义设置节已在客户端实现,关闭本条目的自动设置表单。 */
	ctx.effect(() => ctx.settings.configure({ auto: false }, ctx.fiber), "dsh-token-billing: settings form off");

	ctx.effect(() => ctx.inject(["sessionProjections"], (projectionCtx) => {
		projectionCtx.sessionProjections.register(tokenUsageByModelProjection);
	}), "dsh-token-billing: tokenUsageByModel projection");

	/* Price table lives in this entry's config (schema: exported Config);
	   the client half reads/writes it through the same-origin endpoints. */
	const readConfig = () => normalizeConfig(config);

	const writeConfig = async (next) => {
		const editor = ctx.get("configEditor");
		const entry = ctx.fiber && ctx.fiber.entry;
		if (!editor || !entry) throw new Error("configEditor unavailable");
		await editor.edit(entry, () => normalizeConfig(next));
	};

	/* Same-origin config endpoints for the client half. */
	ctx.effect(() => ctx.webServer.register({
			kind: "prefix",
			path: "/dsh-token-billing",
			handler: async (req, res) => {
				const url = new URL(req.url, "http://localhost");
				if (!url.pathname.endsWith("/config")) {
					sendJson(res, 404, { ok: false, reason: "not-found" });
					return;
				}
				if (req.method === "GET") {
					sendJson(res, 200, { ok: true, ...readConfig() });
					return;
				}
				if (req.method !== "POST") {
					sendJson(res, 405, { ok: false, reason: "method" });
					return;
				}
				try {
					const body = await readJsonBody(req);
					const next = normalizeConfig(body);
					await writeConfig(next);
					/* 回显新值:configEditor 生效要等 fiber 重跑。 */
					sendJson(res, 200, { ok: true, ...next });
				} catch (err) {
					sendJson(res, 400, { ok: false, reason: String(err?.message ?? err) });
				}
			},
		}), "dsh-token-billing: /dsh-token-billing route");
}
