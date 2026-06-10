"use server";

import { revalidatePath } from "next/cache";
import { authedClient } from "./_helpers";

/**
 * Stamp the user's "last viewed the Applications outbox" time to now. Drives
 * the sidebar Applications badge — after this fires, the badge counts only
 * cover letters that complete later, so the count clears on view and stays
 * cleared until something new lands. Fired client-side from the outbox page.
 */
export async function markApplicationsSeen() {
  const { supabase, user } = await authedClient();
  await supabase
    .from("users")
    .update({ applications_seen_at: new Date().toISOString() })
    .eq("id", user.id);
  revalidatePath("/dashboard", "layout");
}

