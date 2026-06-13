// Cost cap — hard limit of $5/user/month on AI usage.
// Uses millicents (1/1000 of a cent) for integer precision.
//
// Pricing per provider (millicents per token):
//   openai/gpt-4o-mini:        input $0.15/1M = 0.15mc  | output $0.60/1M = 0.60mc
//   anthropic/haiku-4-5 batch: input $0.40/1M = 0.04mc  | output $2.00/1M = 0.20mc
//   (Anthropic batch = 50% off standard rates)
import { db } from "../db/client.js";

const CAP_MILLICENTS = 5 * 100 * 1000; // $5.00 = 500,000 millicents

type ProviderPricing = { input: number; output: number };

const PRICING: Record<string, ProviderPricing> = {
  openai:    { input: 0.15, output: 0.60 },
  anthropic: { input: 0.04, output: 0.20 },
};

function getPricing(): ProviderPricing {
  const provider = (process.env.AI_PROVIDER ?? "openai").toLowerCase();
  return PRICING[provider] ?? PRICING.openai;
}

// Millicents per token — resolved at call time so env var changes are respected
const INPUT_MC_PER_TOKEN  = getPricing().input;
const OUTPUT_MC_PER_TOKEN = getPricing().output;

export function estimateCostMillicents(inputTokens: number, outputTokens: number): number {
  return Math.ceil(inputTokens * INPUT_MC_PER_TOKEN + outputTokens * OUTPUT_MC_PER_TOKEN);
}

export async function monthlySpendMillicents(userId: string): Promise<number> {
  const { data } = await db
    .rpc("monthly_ai_spend_millicents", { p_user_id: userId });
  return (data as number | null) ?? 0;
}

export async function wouldExceedCap(
  userId: string,
  estimatedInputTokens: number
): Promise<boolean> {
  const current = await monthlySpendMillicents(userId);
  // Estimate conservatively: 256 output tokens per job
  const projected = estimateCostMillicents(estimatedInputTokens, 256);
  return current + projected > CAP_MILLICENTS;
}

export async function recordUsage(
  runLogId: string,
  inputTokens: number,
  outputTokens: number
): Promise<void> {
  const cost = estimateCostMillicents(inputTokens, outputTokens);
  await db
    .from("run_logs")
    .update({
      ai_tokens_input: inputTokens,
      ai_tokens_output: outputTokens,
      ai_cost_cents: cost,
    })
    .eq("id", runLogId);
}
