import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url) throw new Error("SUPABASE_URL is required");
if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is required");

// Service-role client: bypasses RLS. Only used inside the worker.
// Never expose this key to the browser.
export const db = createClient(url, key, {
  auth: { persistSession: false },
});
