/**
 * dsh-token-billing host half: registers the per-model token-usage session
 * projection. A conversation may switch models several times; each
 * `assistant/message` event carries its step's usage AND the producing
 * model's identity (message.source.model), so the projection folds usage
 * per model (replace-per-step, last wins on retries) and exposes
 * `{ byModel, totals }` to the client through useProjection("tokenUsageByModel").
 */
import z from "zod";

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

export function apply(ctx) {
	ctx.inject(["sessionProjections"], (projectionCtx) => {
		projectionCtx.sessionProjections.register(tokenUsageByModelProjection);
	});
}
