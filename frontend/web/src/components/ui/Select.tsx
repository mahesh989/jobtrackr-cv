import { forwardRef, useId, type SelectHTMLAttributes, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "id"> {
  label: string;
  error?: ReactNode;
  id?: string;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, error, id, className = "", children, ...rest }, ref) => {
    const autoId = useId();
    const selectId = id ?? autoId;
    return (
      <div className="w-full">
        <label htmlFor={selectId} className="block text-sm font-medium text-[var(--text-2)] mb-1">
          {label}
        </label>
        <div className="select-chevron-wrap">
          <select
            ref={ref}
            id={selectId}
            className={`field select-chevron ${error ? "border-[var(--red)]" : ""} ${className}`}
            aria-invalid={!!error || undefined}
            aria-describedby={error ? `${selectId}-error` : undefined}
            {...rest}
          >
            {children}
          </select>
          <ChevronDown size={16} className="text-[var(--text-2)]" />
        </div>
        {error ? (
          <p id={`${selectId}-error`} className="mt-1 text-xs text-[var(--red)]">
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);
Select.displayName = "Select";
