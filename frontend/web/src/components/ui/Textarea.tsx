"use client";

import {
  forwardRef, useCallback, useEffect, useId, useRef,
  type TextareaHTMLAttributes, type ReactNode,
} from "react";
import { FieldLabel, FieldError, FieldHint } from "@/lib/field-utils";

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> {
  label?: string;
  error?: ReactNode;
  /** Helper text shown below the field when there's no error. */
  hint?: ReactNode;
  /** Grow the box to fit its content (no scrollbar, no manual resize handle).
   *  The `rows` attribute stays the minimum height. */
  autoGrow?: boolean;
  id?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, hint, id, required, autoGrow, className = "", value, ...rest }, ref) => {
    const autoId = useId();
    const textareaId = id ?? autoId;

    const innerRef = useRef<HTMLTextAreaElement | null>(null);
    const setRefs = useCallback((el: HTMLTextAreaElement | null) => {
      innerRef.current = el;
      if (typeof ref === "function") ref(el);
      else if (ref) (ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
    }, [ref]);

    useEffect(() => {
      if (!autoGrow) return;
      const el = innerRef.current;
      if (!el) return;
      el.style.height = "auto";                 // reset so it can shrink too
      el.style.height = `${el.scrollHeight}px`; // grow to content (>= rows)
    }, [autoGrow, value]);

    return (
      <div className="w-full">
        {label ? <FieldLabel htmlFor={textareaId} required={required}>{label}</FieldLabel> : null}
        <textarea
          ref={setRefs}
          id={textareaId}
          required={required}
          value={value}
          className={`field ${autoGrow ? "resize-none overflow-hidden" : ""} ${error ? "border-[var(--red)]" : ""} ${className}`}
          aria-invalid={!!error || undefined}
          aria-describedby={error ? `${textareaId}-error` : hint ? `${textareaId}-hint` : undefined}
          {...rest}
        />
        {error ? (
          <FieldError id={`${textareaId}-error`}>{error}</FieldError>
        ) : hint ? (
          <FieldHint id={`${textareaId}-hint`}>{hint}</FieldHint>
        ) : null}
      </div>
    );
  },
);
Textarea.displayName = "Textarea";
