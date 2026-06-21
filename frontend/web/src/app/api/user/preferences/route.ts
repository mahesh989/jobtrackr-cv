/**
 * /api/user/preferences
 *
 * GET   — return the current user's contact_details (or empty if not set)
 * PATCH — replace contact_details with the supplied object
 *
 * contact_details shape (all optional):
 *   {
 *     name, phone, email, address, suburb, postcode,
 *     linkedin, github, website, portfolio,
 *     other_label, other_url,
 *     projects:    [ { name, url, description }, ... ],
 *     credentials: {              // surfaces on nursing/care CVs only
 *       ahpra_number, drivers_licence, work_rights, wwcc_state,
 *       wwcc, police_check, ndis_screening, first_aid, cpr,
 *       medication_competency, own_car, car_insurance, flu_vaccination,
 *     },
 *   }
 */

import { NextRequest, NextResponse } from "next/server";
import { createClient }              from "@/lib/supabase/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { revalidateTag }             from "next/cache";

interface Project {
  name?:        string;
  url?:         string;
  description?: string;
}

interface ProfileCredentials {
  ahpra_number?:         string;
  drivers_licence?:      string;
  work_rights?:          string;
  work_rights_hours?:    string;
  wwcc_state?:           string;
  forklift_licence?:     string;
  wwcc?:                 boolean;
  police_check?:         boolean;
  ndis_screening?:       boolean;
  first_aid?:            boolean;
  cpr?:                  boolean;
  medication_competency?: boolean;
  own_car?:              boolean;
  car_insurance?:        boolean;
  flu_vaccination?:      boolean;
  covid_vaccination?:    boolean;
  white_card?:           boolean;
  availability?:         string[];  // subset of ["Full Time","Part Time","Casual"]
  show_availability?:    boolean;   // opt-in: surface availability on the CV
}

type RoleFamily = "tech" | "nursing" | "manual" | "general";
const ROLE_FAMILY_VALUES: readonly RoleFamily[] = ["tech", "nursing", "manual", "general"] as const;

interface Referee {
  name?:      string;
  job_title?: string;
  company?:   string;
  email?:     string;
}

interface References {
  mode?:                 "details" | "on_request" | "none";
  available_on_request?: boolean; // legacy
  referees?:             Referee[];
}

interface ContactDetails {
  name?:          string;
  phone?:         string;
  email?:         string;
  address?:       string;
  suburb?:        string;
  postcode?:      string;
  linkedin?:      string;
  github?:        string;
  website?:       string;
  portfolio?:     string;
  other_label?:   string;
  other_url?:     string;
  projects?:      Project[];
  role_families?: RoleFamily[];
  credentials?:   ProfileCredentials;
  references?:    References;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE   = /^https?:\/\/[^\s]+$/i;

function sanitise(input: unknown): { ok: true; value: ContactDetails } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "Body must be an object" };
  const i = input as Record<string, unknown>;
  const out: ContactDetails = {};
  const strKeys = ["name", "phone", "address", "suburb", "postcode", "other_label"] as const;
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
  if (i.credentials && typeof i.credentials === "object") {
    const c = i.credentials as Record<string, unknown>;
    const creds: ProfileCredentials = {};
    const credStr = ["ahpra_number", "drivers_licence", "work_rights", "work_rights_hours", "wwcc_state", "forklift_licence"] as const;
    for (const k of credStr) {
      if (typeof c[k] === "string") {
        const v = (c[k] as string).trim();
        if (v) creds[k] = v;
      }
    }
    const credBool = [
      "wwcc", "police_check", "ndis_screening", "first_aid", "cpr",
      "medication_competency", "own_car", "car_insurance", "flu_vaccination",
      "covid_vaccination", "white_card", "show_availability",
    ] as const;
    for (const k of credBool) {
      if (c[k] === true) creds[k] = true;
    }
    // Availability — constrain to the known shift types; drop anything else.
    if (Array.isArray(c.availability)) {
      const AVAIL = ["Full Time", "Part Time", "Casual"];
      const picked = c.availability
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim())
        .filter((v) => AVAIL.includes(v));
      if (picked.length > 0) creds.availability = [...new Set(picked)];
    }
    // Only attach when at least one credential was supplied — keeps the
    // stored JSON minimal and the no-credentials path identical to today.
    if (Object.keys(creds).length > 0) out.credentials = creds;
  }
  if (Array.isArray(i.role_families)) {
    const families: RoleFamily[] = [];
    for (const raw of i.role_families) {
      if (typeof raw !== "string") continue;
      const v = raw.trim().toLowerCase();
      if ((ROLE_FAMILY_VALUES as readonly string[]).includes(v) && !families.includes(v as RoleFamily)) {
        families.push(v as RoleFamily);
      }
    }
    // Persist the array even when empty — empty signals "no selection yet"
    // (UI shows all add-on cards), distinct from undefined.
    out.role_families = families;
  }
  if (i.references && typeof i.references === "object") {
    const ref = i.references as Record<string, unknown>;
    const parsed: References = {};
    const VALID_MODES = new Set(["details", "on_request", "none"]);
    if (typeof ref.mode === "string" && VALID_MODES.has(ref.mode)) {
      parsed.mode = ref.mode as References["mode"];
    }
    // legacy boolean field
    if (typeof ref.available_on_request === "boolean") {
      parsed.available_on_request = ref.available_on_request;
    }
    if (Array.isArray(ref.referees)) {
      const referees: Referee[] = [];
      for (const raw of ref.referees) {
        if (!raw || typeof raw !== "object") continue;
        const r = raw as Record<string, unknown>;
        const referee: Referee = {};
        if (typeof r.name      === "string") referee.name      = r.name.trim()      || undefined;
        if (typeof r.job_title === "string") referee.job_title = r.job_title.trim() || undefined;
        if (typeof r.company   === "string") referee.company   = r.company.trim()   || undefined;
        if (typeof r.email     === "string") {
          const v = r.email.trim();
          if (v && !EMAIL_RE.test(v)) return { ok: false, error: `Invalid referee email: ${v}` };
          referee.email = v || undefined;
        }
        if (referee.name || referee.job_title || referee.company || referee.email) {
          referees.push(referee);
        }
      }
      parsed.referees = referees.slice(0, 3); // hard cap at 3
    }
    out.references = parsed;
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

  if (error) {
    console.error("[/api/user/preferences] upsert error:", error.message);
    return NextResponse.json({ error: "Request failed" }, { status: 500 });
  }
  revalidateTag(`preferences-${user.id}`, "default");
  return NextResponse.json({ contact_details: result.value });
}
