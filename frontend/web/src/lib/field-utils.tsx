"use client";

/**
 * field-utils — single source of truth for how a field's label, error, and
 * hint render. Every form control (Input / Select / Textarea / FormField)
 * composes these three, so the label weight, error colour, and hint tone
 * are defined exactly once. Mirrors form-patterns.html Pattern A
 * (.form-label / .form-error / .form-hint).
 */

import type { ReactNode } from "react";

export function FieldLabel({
  htmlFor, children, required,
}: {
  htmlFor?: string;
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <label htmlFor={htmlFor} className="block text-label font-semibold text-text mb-1">
      {children}
      {required && <span className="text-[var(--red)] ml-0.5">*</span>}
    </label>
  );
}

export function FieldError({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="mt-1 text-caption text-[var(--red)]">{children}</p>
  );
}

export function FieldHint({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="mt-1 text-caption text-text-3">{children}</p>
  );
}
