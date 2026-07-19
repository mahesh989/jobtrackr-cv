import { forwardRef, useId, type TextareaHTMLAttributes, type ReactNode } from "react";

export interface TextareaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "id"> {
  label: string;
  error?: ReactNode;
  id?: string;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, id, className = "", ...rest }, ref) => {
    const autoId = useId();
    const textareaId = id ?? autoId;
    return (
      <div className="w-full">
        <label htmlFor={textareaId} className="block text-sm font-medium text-[var(--text-2)] mb-1">
          {label}
        </label>
        <textarea
          ref={ref}
          id={textareaId}
          className={`field ${error ? "border-[var(--red)]" : ""} ${className}`}
          aria-invalid={!!error || undefined}
          aria-describedby={error ? `${textareaId}-error` : undefined}
          {...rest}
        />
        {error ? (
          <p id={`${textareaId}-error`} className="mt-1 text-xs text-[var(--red)]">
            {error}
          </p>
        ) : null}
      </div>
    );
  },
);
Textarea.displayName = "Textarea";
