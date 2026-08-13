/**
 * Shared fix for the `.in()` bug family (audit finding, cross-cutting): a
 * single unchunked PostgREST `.in()` with a large value list builds a GET
 * querystring past the proxy/PostgREST URL limit and fails SILENTLY
 * (`data: null`, no throw) — first diagnosed and fixed at
 * `pipeline/orchestrator/earlyDedup.ts` stage 3. This extracts that fix into
 * a reusable primitive so every other unbounded `.in()` site in the worker
 * can adopt the same, already-proven chunking shape instead of re-deriving
 * it (or forgetting it) individually.
 *
 * Non-fatal by design, matching earlyDedup's existing convention: a failed
 * chunk is skipped (not thrown), since callers here all treat a partial or
 * missing result as "fall through to a later, correctness-preserving path"
 * (L2 dedup, a fresh geocode, etc.) rather than a hard failure.
 */
export interface ChunkedInResult<Row> {
  rows: Row[];
  hadError: boolean;
}

const DEFAULT_CHUNK_SIZE = 150;

export async function selectInChunked<Row>(
  values: readonly string[],
  queryForChunk: (chunk: string[]) => PromiseLike<{ data: Row[] | null; error: { message: string } | null }>,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): Promise<ChunkedInResult<Row>> {
  if (values.length === 0) return { rows: [], hadError: false };

  const chunks: string[][] = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    chunks.push(values.slice(i, i + chunkSize));
  }

  const results = await Promise.all(chunks.map((chunk) => queryForChunk(chunk)));

  const rows: Row[] = [];
  let hadError = false;
  for (const { data, error } of results) {
    if (error) {
      hadError = true;
      continue;
    }
    if (data) rows.push(...data);
  }
  return { rows, hadError };
}
