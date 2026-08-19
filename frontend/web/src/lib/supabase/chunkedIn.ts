/**
 * Shared fix for the `.in()` bug family (audit finding, cross-cutting): a
 * single unchunked PostgREST `.in()` with a large value list builds a GET
 * querystring past the proxy/PostgREST URL limit and fails SILENTLY
 * (`data: null`, no throw) — first diagnosed and fixed on the worker side at
 * `backend/worker/src/pipeline/orchestrator/earlyDedup.ts` stage 3. Same
 * primitive, ported to the web app's own Supabase call shape (execution
 * chunk C44).
 *
 * Non-fatal by design: a failed chunk is skipped, not thrown — every call
 * site here already tolerates a partial/empty result the same way it always
 * tolerated `data: null` (an under-count or a missing badge, never a crash).
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
