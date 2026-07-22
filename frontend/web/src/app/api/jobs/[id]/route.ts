/**
 * PATCH /api/jobs/[id]
 *
 * Update mutable per-job fields owned by the user:
 *   - manual_jd_text: cleaned JD text the AI should see (replaces description
 *                     in the analyze flow). Pass null to clear and fall back
 *                     to the original description / scrape.
 *   - contact_email:  recruiter contact for future MCP email-send flow.
 *   - hiring_manager: name of the hiring manager for cover letter salutation.
 *   - company_address: multi-line postal address for cover letter employer block.
 *
 * Ownership chain: job → search_profile → user. Service-role write only after
 * we verify the chain — service-role bypasses RLS, so the check must run.
 */

import { NextRequest, NextResponse } from "next/server";
import { createAdminClient }         from "@/lib/supabase/admin";
import { classifySettingText }       from "@/lib/workSetting/classifier";
import { withUser } from "@/lib/api-utils";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_JD_CHARS = 60_000;          // sane upper bound — tokens get expensive

export const PATCH = withUser(async (
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
  { user },
) => {
  const { id: jobId } = await params;


  let body: {
    manual_jd_text?:  string | null;
    contact_email?:   string | null;
    hiring_manager?:  string | null;
    company_address?: string | null;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Build the update patch, only including fields the caller actually sent.
  const patch: Record<string, string | number | null> = {};

  if ("manual_jd_text" in body) {
    const raw = body.manual_jd_text;
    if (raw === null || raw === "") {
      patch.manual_jd_text = null;
    } else if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (trimmed.length > MAX_JD_CHARS) {
        return NextResponse.json(
          { error: `JD text is too long (${trimmed.length} chars). Cap is ${MAX_JD_CHARS}.` },
          { status: 422 },
        );
      }
      patch.manual_jd_text = trimmed.length === 0 ? null : trimmed;
    } else {
      return NextResponse.json({ error: "manual_jd_text must be a string or null" }, { status: 400 });
    }
  }

  if ("contact_email" in body) {
    const raw = body.contact_email;
    if (raw === null || raw === "") {
      patch.contact_email = null;
    } else if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (!EMAIL_RE.test(trimmed)) {
        return NextResponse.json(
          { error: `'${trimmed}' is not a valid email address` },
          { status: 422 },
        );
      }
      patch.contact_email = trimmed;
    } else {
      return NextResponse.json({ error: "contact_email must be a string or null" }, { status: 400 });
    }
  }

  if ("hiring_manager" in body) {
    const raw = body.hiring_manager;
    if (raw === null || raw === "") {
      patch.hiring_manager = null;
    } else if (typeof raw === "string") {
      const trimmed = raw.trim();
      patch.hiring_manager = trimmed.length === 0 ? null : trimmed;
    } else {
      return NextResponse.json({ error: "hiring_manager must be a string or null" }, { status: 400 });
    }
  }

  if ("company_address" in body) {
    const raw = body.company_address;
    if (raw === null || raw === "") {
      patch.company_address = null;
    } else if (typeof raw === "string") {
      // Preserve internal newlines but trim leading/trailing whitespace per line
      // and collapse trailing blank lines so the field stays tidy.
      const cleaned = raw
        .split("\n")
        .map((l) => l.trim())
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      patch.company_address = cleaned.length === 0 ? null : cleaned;
    } else {
      return NextResponse.json({ error: "company_address must be a string or null" }, { status: 400 });
    }
  }

  // Classify the WORK SETTING of a manually pasted JD (Migration 078). Manual
  // jobs bypass the worker/bucket pipeline, so we run the deterministic setting
  // rule here so hand-added thin-JD jobs still carry a setting_category (badge +
  // per-profile filter). Only on a non-empty paste — clearing manual_jd_text
  // leaves the original scrape's classification intact.
  if (typeof patch.manual_jd_text === "string" && patch.manual_jd_text.length > 0) {
    const s = classifySettingText(patch.manual_jd_text);
    if (s.setting_category !== null) {
      patch.setting_category   = s.setting_category;
      patch.setting_confidence = s.setting_confidence;
      patch.setting_evidence   = s.setting_evidence;
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "No supported fields in request" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Ownership check: load the job's profile_id, then verify the profile belongs
  // to the user. Service-role bypasses RLS so this check is non-optional.
  const { data: job } = await admin
    .from("jobs")
    .select("id, profile_id")
    .eq("id", jobId)
    .maybeSingle();
  if (!job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  const { data: profile } = await admin
    .from("search_profiles")
    .select("user_id")
    .eq("id", job.profile_id)
    .maybeSingle();
  if (!profile || profile.user_id !== user.id) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  const { data: updated, error } = await admin
    .from("jobs")
    .update(patch)
    .eq("id", jobId)
    .select("id, manual_jd_text, contact_email, hiring_manager, company_address, setting_category, setting_confidence, setting_evidence")
    .single();

  if (error || !updated) {
    console.error("[/api/jobs/:id PATCH] update failed:", error?.message);
    return NextResponse.json({ error: "Failed to update job" }, { status: 500 });
  }

  return NextResponse.json(updated);
});
