"use client";

import { Check, X } from "lucide-react";

export interface PasswordRule {
  key: string;
  label: string;
  test: (password: string) => boolean;
}

export const PASSWORD_RULES: PasswordRule[] = [
  { key: "length",  label: "At least 8 characters",        test: (p) => p.length >= 8 },
  { key: "upper",   label: "One uppercase letter",          test: (p) => /[A-Z]/.test(p) },
  { key: "lower",   label: "One lowercase letter",          test: (p) => /[a-z]/.test(p) },
  { key: "number",  label: "One number",                    test: (p) => /[0-9]/.test(p) },
  { key: "special", label: "One special character",         test: (p) => /[^A-Za-z0-9]/.test(p) },
  { key: "space",   label: "No spaces",                     test: (p) => p.length > 0 && !/\s/.test(p) },
];

export function passwordMeetsAllRules(password: string): boolean {
  return PASSWORD_RULES.every((r) => r.test(password));
}

/**
 * Live password-strength checklist — replaces relying on the browser's
 * native `minLength` validation bubble, which fires before our own submit
 * handler runs and shows a generic, unbranded message.
 */
export function PasswordRequirements({ password }: { password: string }) {
  return (
    <ul className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5">
      {PASSWORD_RULES.map((rule) => {
        const met = rule.test(password);
        return (
          <li
            key={rule.key}
            className="flex items-center gap-1.5 text-[12px] transition-colors"
            style={{ color: met ? "#0B7D74" : "#667085" }}
          >
            {met ? (
              <Check className="w-3.5 h-3.5 shrink-0" />
            ) : (
              <X className="w-3.5 h-3.5 shrink-0 opacity-40" />
            )}
            {rule.label}
          </li>
        );
      })}
    </ul>
  );
}
