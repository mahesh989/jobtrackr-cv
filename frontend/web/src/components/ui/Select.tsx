import { forwardRef, useId, type SelectHTMLAttributes, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { FieldLabel, FieldError, FieldHint } from "@/lib/field-utils";

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> {
  label?: string;
  error?: ReactNode;
  /** Helper text shown below the field when there's no error. */
  hint?: ReactNode;
  id?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, error, hint, id, required, className = "", children, ...rest }, ref) => {
    const autoId = useId();
    const selectId = id ?? autoId;
    return (
      <div className="w-full">
        {label ? <FieldLabel htmlFor={selectId} required={required}>{label}</FieldLabel> : null}
        <div className="select-chevron-wrap">
          <select
            ref={ref}
            id={selectId}
            required={required}
            className={`field select-chevron ${error ? "border-[var(--red)]" : ""} ${className}`}
            aria-invalid={!!error || undefined}
            aria-describedby={error ? `${selectId}-error` : hint ? `${selectId}-hint` : undefined}
            {...rest}
          >
            {children}
          </select>
          <ChevronDown size={16} className="text-[var(--text-2)]" />
        </div>
        {error ? (
          <FieldError id={`${selectId}-error`}>{error}</FieldError>
        ) : hint ? (
          <FieldHint id={`${selectId}-hint`}>{hint}</FieldHint>
        ) : null}
      </div>
    );
  },
);
Select.displayName = "Select";
