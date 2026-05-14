/**
 * /api/user/preferences
 *
 * GET   — return the current user's contact_details (or empty if not set)
 * PATCH — replace contact_details with the supplied object
 *
 * contact_details shape (all optional):
 *   {
 *     name, phone, email, address,
 *     linkedin, github, website, portfolio,
 *     other_label, other_url,
 *     projects: [ { name, url, description }, ... ]
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@/lib/supabase/server";
import { createAdminClient }         from "@/lib/supabase/admin";

interface Project {
  name?:        string;
  url?:         string;
  description?: string;
}

interface ContactDetails {
  name?:         string;
  phone?:        string;
  email?:        string;
  address?:      string;
  linkedin?:     string;
  github?:       string;
  website?:      string;
  portfolio?:    string;
  other_label?:  string;
  other_url?:    string;
  projects?:     Project[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE   = /^https?:\/\/[^\s]+$/i;

function sanitise(input: unknown): { ok: true; value: ContactDetails } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "Body must be an object" };
  const i = input as Record<string, unknown>;
  const out: ContactDetails = {};
  const strKeys = ["name", "phone", "address", "other_label"] as const;
  for (const k of strKeys) {
    if (typeof i[k] === "string") out[k] = (i[k] as string).trim() || undefined;
  }
  if (typeof i.email === "string") {
    const v = i.email.trim();
    if (v && !EMAIL_RE.test(v)) return { ok: false, error: `Invalid email: ${v}` };
    out.email = v || undefined;
  }
  const urlKeys = ["linkedin", "github", "website", "portfolio", "other_url"] as const;
  for (const k of urlKeys) {
    if (typeof i[k] === "string") {
      const v = i[k] as string;
      const trimmed = v.trim();
      if (trimmed && !URL_RE.test(trimmed)) return { ok: false, error: `Invalid URL for ${k}: ${trimmed}` };
      out[k] = trimmed || undefined;
    }
  }
  if (Array.isArray(i.projects)) {
    const projects: Project[] = [];
    for (const raw of i.projects) {
      if (!raw || typeof raw !== "object") continue;
      const p = raw as Record<string, unknown>;
      const proj: Project = {};
      if (typeof p.name === "string")        proj.name = p.name.trim() || undefined;
      if (typeof p.description === "string") proj.description = p.description.trim() || undefined;
      if (typeof p.url === "string") {
        const v = p.url.trim();
        if (v && !URL_RE.test(v)) return { ok: false, error: `Invalid project URL: ${v}` };
        proj.url = v || undefined;
      }
      // Skip wholly-empty rows
      if (proj.name || proj.url || proj.description) projects.push(proj);
    }
    if (projects.length > 0) out.projects = projects;
  }
  return { ok: true, value: out };
}

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const admin = createAdminClient();
  const { data } = await admin
    .from("user_preferences")
    .select("contact_details")
    .eq("user_id", user.id)
    .maybeSingle();

  return NextResponse.json({
    contact_details: (data?.contact_details as ContactDetails | null) ?? null,
  });
}

export async function PATCH(req: NextRequest) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let body: { contact_details?: unknown };
  try { body = await req.json(); }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }

  const result = sanitise(body.contact_details);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 422 });

  const admin = createAdminClient();
  const { error } = await admin
    .from("user_preferences")
    .upsert(
      { user_id: user.id, contact_details: result.value, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ contact_details: result.value });
}
