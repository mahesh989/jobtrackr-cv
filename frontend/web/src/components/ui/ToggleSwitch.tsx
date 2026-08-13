"use client";

/**
 * On/off pill switch (Notifications toggle, and any future settings
 * toggle). Single occurrence today, but exactly the kind of control that
 * recurs — worth its own single-sourced primitive from the start.
 */
export function ToggleSwitch({
  checked, onChange, disabled = false, className = "",
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      disabled={disabled}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
        checked ? "bg-[var(--brand)]" : "bg-[var(--border)]"
      } ${disabled ? "opacity-60" : ""} ${className}`.trim()}
    >
      <span
        className={`inline-block h-3.5 w-3.5 transform rounded-full transition-transform ${
          // On (bg-[var(--brand)] track): brand-fg, same token the brand
          // CTAs use, so the knob stays visible on every theme — a plain
          // white knob was 1.57:1 on Gilded Noir / 1.63:1 on Aurora Dark.
          // Off (bg-[var(--border)] track) is unaffected — untouched.
          checked ? "bg-brand-fg" : "bg-white"
        } ${checked ? "translate-x-[18px]" : "translate-x-[3px]"}`}
      />
    </button>
  );
}
