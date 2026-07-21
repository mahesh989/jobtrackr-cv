import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "type"> {
  label: ReactNode;
  error?: ReactNode;
  id?: string;
}

export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(
  ({ label, error, id, className = "", ...rest }, ref) => {
    const autoId = useId();
    const checkboxId = id ?? autoId;
    return (
      <label htmlFor={checkboxId} className="flex items-center gap-2 cursor-pointer select-none">
        <input
          ref={ref}
          id={checkboxId}
          type="checkbox"
          className={`h-4 w-4 rounded border-[var(--border)] accent-[var(--brand)] focus:ring-[var(--brand)]/30 ${className}`}
          aria-invalid={!!error || undefined}
          {...rest}
        />
        <span className="text-[13px] text-text">{label}</span>
        {error ? <span className="text-xs text-[var(--red)]">{error}</span> : null}
      </label>
    );
  },
);
Checkbox.displayName = "Checkbox";
