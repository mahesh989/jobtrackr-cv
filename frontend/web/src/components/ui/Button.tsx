"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode, type ReactElement, type Ref, cloneElement, isValidElement } from "react";

const variantClass = {
  default: "gh-btn",
  /** The app's primary-CTA look (Analyze, Save, Send, Apply, Upload…) — always
   *  matches the active theme's --brand. */
  brand: "gh-btn gh-btn-brand",
  /** @deprecated alias of `brand`. `primary` used to be a hardcoded GitHub
   *  green that stayed green on every non-Aurora theme, which is why CTAs
   *  looked inconsistent; it now resolves to the same theme-brand look.
   *  Prefer `variant="brand"` in new code. */
  primary: "gh-btn gh-btn-brand",
  blue: "gh-btn gh-btn-blue",
  danger: "gh-btn gh-btn-danger",
} as const;

/** .gh-btn intentionally carries no padding/font-size (see globals.css) — this
 *  map is the single source of truth for Button sizing across every variant.
 *  Pick the closest tier instead of overriding padding/text size in
 *  className — two Tailwind utilities for the same property (one from here,
 *  one hand-typed) have no guaranteed winner, so redundant per-instance
 *  overrides silently reopen the same bug this map exists to close. */
const sizeClass = {
  xs: "text-[11px] px-2.5 py-1",
  sm: "text-[12px] px-3 py-1.5",
  md: "text-[13px] px-3 py-[5px]",
  lg: "text-sm px-4 py-2",
} as const;

/** ponytail: minimal Slot — merges props onto a single child element. No dependency needed. */
function Slot({ children, ...props }: { children: ReactElement; [key: string]: unknown }) {
  if (!isValidElement(children)) return null;
  const childProps = (children.props ?? {}) as Record<string, unknown>;
  const mergedClassName = [props.className, childProps.className].filter(Boolean).join(" ");
  return cloneElement(children, {
    ...props,
    ...childProps,
    className: mergedClassName || undefined,
  } as React.HTMLAttributes<HTMLElement>);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variantClass;
  size?: keyof typeof sizeClass;
  isLoading?: boolean;
  icon?: ReactNode;
  asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "default",
      size = "md",
      isLoading = false,
      icon,
      className = "",
      disabled,
      children,
      asChild = false,
      ...rest
    },
    ref,
  ) => {
    const combinedClassName = `${variantClass[variant]} ${sizeClass[size]} ${className}`.trim();

    if (asChild && isValidElement(children)) {
      return (
        <Slot
          ref={ref as Ref<HTMLElement>}
          className={combinedClassName}
          {...rest}
        >
          {children as ReactElement<Record<string, unknown>>}
        </Slot>
      );
    }

    return (
      <button
        ref={ref}
        className={combinedClassName}
        disabled={disabled || isLoading}
        {...rest}
      >
        {isLoading ? (
          <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
        ) : icon ? (
          <span className="shrink-0">{icon}</span>
        ) : null}
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";
