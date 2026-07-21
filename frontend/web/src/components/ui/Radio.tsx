import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";

export interface RadioProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id" | "type"> {
  label: ReactNode;
  error?: ReactNode;
  id?: string;
}

export const Radio = forwardRef<HTMLInputElement, RadioProps>(
  ({ label, error, id, className = "", ...rest }, ref) => {
    const autoId = useId();
    const radioId = id ?? autoId;
    return (
      <label htmlFor={radioId} className="flex items-center gap-1.5 cursor-pointer">
        <input
          ref={ref}
          id={radioId}
          type="radio"
          className={`h-3.5 w-3.5 accent-[var(--brand)] ${className}`}
          {...rest}
        />
        <span className="text-body text-text-2">{label}</span>
        {error ? <span className="text-xs text-[var(--red)]">{error}</span> : null}
      </label>
    );
  },
);
Radio.displayName = "Radio";
