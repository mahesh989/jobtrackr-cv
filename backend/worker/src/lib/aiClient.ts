/**
 * Shared tiny-classification AI call — Anthropic/OpenAI routing + JSON
 * extraction, used by visaExtractor.ts and settingClassifier.ts for their
 * cheap AI-fallback step (both: extracted sentences in, one JSON object out).
 *
 * Not for the main tailored-CV/cover-letter generation path — that's
 * backend/api's much larger ai/client.py, a different service entirely.
 */

/**
 * Call the configured provider (AI_PROVIDER env, default "openai") with a
 * system + user message and parse the first {...} JSON object out of the
 * response. Returns null on any failure (missing JSON, parse error, API
 * error) — callers treat null as "fall back to the deterministic result".
 */
export async function callAI<T>(
  logTag:       string,
  systemPrompt: string,
  userMessage:  string,
  maxTokens:    number,
): Promise<T | null> {
  const provider = (process.env.AI_PROVIDER ?? "openai").toLowerCase();

  try {
    if (provider === "anthropic") {
      const { default: Anthropic } = await import("@anthropic-ai/sdk");
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const res = await client.messages.create({
        model: "claude-haiku-4-5",
        max_tokens: maxTokens,
        system: systemPrompt,
        messages: [{ role: "user", content: userMessage }],
      });
      const text = res.content.find((b) => b.type === "text")?.text ?? "";
      const json = text.match(/\{[\s\S]*\}/)?.[0];
      return json ? (JSON.parse(json) as T) : null;
    }

    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const res = await client.chat.completions.create({
      model: "gpt-4o-mini",
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    });
    const text = res.choices[0]?.message?.content ?? "";
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    return json ? (JSON.parse(json) as T) : null;
  } catch (err) {
    console.warn(`[${logTag}] AI fallback error:`, err);
    return null;
  }
}
