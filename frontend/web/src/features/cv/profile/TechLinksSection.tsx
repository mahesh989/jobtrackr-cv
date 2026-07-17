"use client";

import { Field } from "./Field";
import type { ContactDetails } from "./types";

export function TechLinksSection({
  cd, setField,
}: {
  cd:       ContactDetails;
  setField: <K extends keyof ContactDetails>(k: K, v: string) => void;
}) {
  return (
    <div className="glass rounded-lg shadow-gold p-6 space-y-4">
      <div>
        <h2 className="label-luxury text-text-2">Tech / Engineering Links</h2>
        <p className="mt-1 text-xs text-text-3">
          Surface on the contact line for tech / engineering / data CVs.
          Leave blank to omit. Portfolio is preferred; Website is shown
          only when no Portfolio is set.
        </p>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="GitHub URL"    value={cd.github    ?? ""} onChange={(v) => setField("github",    v)} placeholder="github.com/yourname" />
        <Field label="Portfolio URL" value={cd.portfolio ?? ""} onChange={(v) => setField("portfolio", v)} placeholder="yourname.dev" />
        <Field label="Website URL"   value={cd.website   ?? ""} onChange={(v) => setField("website",   v)} placeholder="(used only if no Portfolio)" />
      </div>
    </div>
  );
}
