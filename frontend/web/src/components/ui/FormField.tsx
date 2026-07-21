"use client";

import { useId, type ReactNode } from "react";
import { FieldLabel, FieldError, FieldHint } from "@/lib/field-utils";

/**
 * FormField — wraps an arbitrary control (a custom picker, a LocationAutocomplete,
 * a radio group…) in the same label + error + hint treatment that Input/Select/
 * Textarea render internally. Use this when the control isn't one of the three
 * base field components but should still look like a Pattern A field.
 *
 * Passes a generated id to `children` via a render-prop so the label's htmlFor
 * links correctly, or accepts a plain node when linking isn't needed.
 */
export function FormField({
  label, required, error, hint, htmlFor, children, className = "",
}: {
  label?: ReactNode;
  required?: boolean;
  error?: ReactNode;
  hint?: ReactNode;
  /** id of the control the label points at. Omit for non-focusable groups. */
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  const autoId = useId();
  const controlId = htmlFor ?? autoId;
  return (
    <div className={`w-full ${className}`}>
      {label ? <FieldLabel htmlFor={controlId} required={required}>{label}</FieldLabel> : null}
      {children}
      {error ? <FieldError>{error}</FieldError> : hint ? <FieldHint>{hint}</FieldHint> : null}
    </div>
  );
}
