/**
 * Client-side tailored-CV PDF helpers shared by the application cards
 * (split out of CardV2.tsx — audit batch 5.2).
 */
import { createClient as createSupabaseClient } from "@/lib/supabase/client";
import type { ContactDetails } from "@/lib/types";

export function presentBlob(win: Window | null, blob: Blob, filename: string): "tab" | "download" {
  const url = URL.createObjectURL(blob);
  if (win && !win.closed) {
    win.location.replace(url);
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return "tab";
  }
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return "download";
}


export async function loadCvInputs(
  storagePath: string,
): Promise<{ markdown: string; contactDetails: ContactDetails | null }> {
  const supabase = createSupabaseClient();
  const [{ data: mdBlob, error: dlErr }, prefsRes] = await Promise.all([
    supabase.storage.from("tailored-cvs").download(storagePath),
    fetch("/api/user/preferences"),
  ]);
  if (dlErr || !mdBlob) throw new Error(dlErr?.message ?? "Couldn't load CV markdown");
  const markdown = await mdBlob.text();
  let contactDetails: ContactDetails | null = null;
  if (prefsRes.ok) {
    const json = await prefsRes.json();
    if (json?.contact_details) {
      const cd = { ...json.contact_details };
      delete cd.projects;
      contactDetails = cd as ContactDetails;
    }
  }
  return { markdown, contactDetails };
}

