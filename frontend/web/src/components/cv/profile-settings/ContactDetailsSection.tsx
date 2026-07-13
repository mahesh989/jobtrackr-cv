"use client";

import { Field } from "./Field";
import type { ContactDetails } from "./types";

export function ContactDetailsSection({
  cd, setField, showTech,
}: {
  cd:       ContactDetails;
  setField: <K extends keyof ContactDetails>(k: K, v: string) => void;
  showTech: boolean;
}) {
  return (
    <div className="glass rounded-lg shadow-gold p-6 space-y-4">
      <div>
        <h2 className="label-luxury text-text-2">Contact Details</h2>
        <p className="mt-1 text-xs text-text-3">
          Used to stamp a clean contact line on every tailored CV. LinkedIn
          appears as a clickable link on every CV. Leave fields blank to omit them.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Full Name"          value={cd.name        ?? ""} onChange={(v) => setField("name",        v)} placeholder="Jane Doe" />
        <Field label="Phone"              value={cd.phone       ?? ""} onChange={(v) => setField("phone",       v)} placeholder="+61 414 032 507" type="tel" />
        <Field label="Email"              value={cd.email       ?? ""} onChange={(v) => setField("email",       v)} placeholder="you@example.com" type="email" />
        <Field label="Suburb"             value={cd.suburb      ?? ""} onChange={(v) => setField("suburb",      v)} placeholder="Hurstville" />
        <Field label="State"              value={cd.address     ?? ""} onChange={(v) => setField("address",     v)} placeholder="NSW" />
        <Field label="Postcode"           value={cd.postcode    ?? ""} onChange={(v) => setField("postcode",    v)} placeholder="2220" />
        <Field label="LinkedIn URL"       value={cd.linkedin    ?? ""} onChange={(v) => setField("linkedin",    v)} placeholder="linkedin.com/in/yourname" />
        <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-3">
          <Field label="Other (label)" value={cd.other_label ?? ""} onChange={(v) => setField("other_label", v)} placeholder="e.g. Medium, Substack" />
          <Field label="Other (URL)"   value={cd.other_url   ?? ""} onChange={(v) => setField("other_url",   v)} placeholder="https://..." />
        </div>
      </div>

      <p className="text-xs text-text-3">
        On your CV: <code className="rounded bg-[var(--surface-2)] px-1 py-0.5">State | Phone | Email | LinkedIn</code>
        {(showTech) && <> · plus GitHub / Portfolio when you fill them below</>}
      </p>
    </div>
  );
}
