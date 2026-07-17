"use client";

import { UserCircle2 } from "lucide-react";
import { useProfile } from "./context";
import { SectionCard, Field } from "./primitives";

export function ContactSection() {
  const { cd, setField, family, showErrors } = useProfile();
  const showTech = family === "tech" || family === "general";
  const invalid = (k: string) => showErrors && !((cd as Record<string, string>)[k] ?? "").trim();
  return (
    <SectionCard icon={UserCircle2} title="Contact details" subtitle="Stamped onto every tailored CV. Applies to all CVs. Fields marked * are required.">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Full Name"    value={cd.name        ?? ""} onChange={(v) => setField("name",        v)} placeholder="Jane Doe"          required invalid={invalid("name")} />
        <Field label="Phone"        value={cd.phone       ?? ""} onChange={(v) => setField("phone",       v)} placeholder="+61 414 032 507"   type="tel"   required invalid={invalid("phone")} />
        <Field label="Email"        value={cd.email       ?? ""} onChange={(v) => setField("email",       v)} placeholder="you@example.com"   type="email" required invalid={invalid("email")} />
        <Field label="Suburb"       value={cd.suburb      ?? ""} onChange={(v) => setField("suburb",      v)} placeholder="Hurstville"        required invalid={invalid("suburb")} />
        <Field label="State"        value={cd.address     ?? ""} onChange={(v) => setField("address",     v)} placeholder="NSW"               required invalid={invalid("address")} />
        <Field label="Postcode"     value={cd.postcode    ?? ""} onChange={(v) => setField("postcode",    v)} placeholder="2220"              required invalid={invalid("postcode")} />
        <Field label="LinkedIn URL" value={cd.linkedin    ?? ""} onChange={(v) => setField("linkedin",    v)} placeholder="https://linkedin.com/in/yourname" />
        {showTech && (
          <>
            <Field label="GitHub URL"    value={cd.github    ?? ""} onChange={(v) => setField("github",    v)} placeholder="github.com/yourname" />
            <Field label="Portfolio URL" value={cd.portfolio ?? ""} onChange={(v) => setField("portfolio", v)} placeholder="yourname.dev" />
            <Field label="Website URL"   value={cd.website   ?? ""} onChange={(v) => setField("website",   v)} placeholder="(used only if no Portfolio)" />
          </>
        )}
        <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3">
          <Field label="Other (label)" value={cd.other_label ?? ""} onChange={(v) => setField("other_label", v)} placeholder="e.g. Medium, Substack" />
          <Field label="Other (URL)"   value={cd.other_url   ?? ""} onChange={(v) => setField("other_url",   v)} placeholder="https://..." />
        </div>
      </div>
      <p className="text-xs text-text-3">
        On your CV: <code className="rounded bg-[var(--surface-2)] px-1 py-0.5">State | Phone | Email | LinkedIn</code>
        {showTech && <> · plus GitHub / Portfolio (Portfolio preferred; Website shown only when no Portfolio)</>}
      </p>
    </SectionCard>
  );
}
