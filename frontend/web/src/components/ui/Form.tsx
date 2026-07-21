"use client";

import { forwardRef, type FormHTMLAttributes } from "react";

/**
 * Form — the semantic anchor for Pattern A (traditional, submit-driven) forms.
 * Deliberately thin: it exists so every traditional form shares one element to
 * hang default vertical rhythm and future form-level behaviour on, rather than
 * scattering `<form className="space-y-…">` across the app. Pass `className`
 * to override the default spacing.
 */
export const Form = forwardRef<HTMLFormElement, FormHTMLAttributes<HTMLFormElement>>(
  ({ className = "space-y-5", children, ...rest }, ref) => (
    <form ref={ref} className={className} {...rest}>
      {children}
    </form>
  ),
);
Form.displayName = "Form";
