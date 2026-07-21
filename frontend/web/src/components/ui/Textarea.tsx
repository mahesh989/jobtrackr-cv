import { forwardRef, useId, type TextareaHTMLAttributes, type ReactNode } from "react";
import { FieldLabel, FieldError, FieldHint } from "@/lib/field-utils";

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> {
  label?: string;
  error?: ReactNode;
  /** Helper text shown below the field when there's no error. */
  hint?: ReactNode;
  id?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, hint, id, required, className = "", ...rest }, ref) => {
    const autoId = useId();
    const textareaId = id ?? autoId;
    return (
      <div className="w-full">
        {label ? <FieldLabel htmlFor={textareaId} required={required}>{label}</FieldLabel> : null}
        <textarea
          ref={ref}
          id={textareaId}
          required={required}
          className={`field ${error ? "border-[var(--red)]" : ""} ${className}`}
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
