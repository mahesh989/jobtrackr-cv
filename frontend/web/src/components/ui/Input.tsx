import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  label?: string;
  error?: ReactNode;
  /** Explicit id override. If omitted, an id is generated from the label. */
  id?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, id, className = "", ...rest }, ref) => {
    const autoId = useId();
    const inputId = id ?? autoId;
    return (
      <div className="w-full">
        {label ? (
          <label htmlFor={inputId} className="block text-sm font-medium text-[var(--text-2)] mb-1">
            {label}
          </label>
        ) : null}
        <input
          ref={ref}
          id={inputId}
          className={`field ${error ? "border-[var(--red)]" : ""} ${className}`}
          aria-invalid={!!error || undefined}
          aria-describedby={error ? `${inputId}-error` : undefined}
          {...rest}
        />
        {error ? (
          <p id={`${inputId}-error`} className="mt-1 text-xs text-[var(--red)]">
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);
Input.displayName = "Input";
