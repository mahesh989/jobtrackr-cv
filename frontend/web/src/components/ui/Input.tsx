import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";
import { FieldLabel, FieldError, FieldHint } from "@/lib/field-utils";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  label?: string;
  error?: ReactNode;
  /** Helper text shown below the field when there's no error. */
  hint?: ReactNode;
  /** Explicit id override. If omitted, an id is generated from the label. */
  id?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, hint, id, required, className = "", ...rest }, ref) => {
    const autoId = useId();
    const inputId = id ?? autoId;
    return (
      <div className="w-full">
        {label ? <FieldLabel htmlFor={inputId} required={required}>{label}</FieldLabel> : null}
        <input
          ref={ref}
          id={inputId}
          required={required}
          className={`field ${error ? "border-[var(--red)]" : ""} ${className}`}
          aria-invalid={!!error || undefined}
          aria-describedby={error ? `${inputId}-error` : hint ? `${inputId}-hint` : undefined}
          {...rest}
        />
        {error ? (
          <FieldError id={`${inputId}-error`}>{error}</FieldError>
        ) : hint ? (
          <FieldHint id={`${inputId}-hint`}>{hint}</FieldHint>
        ) : null}
      </div>
    );
  },
);
Input.displayName = "Input";
