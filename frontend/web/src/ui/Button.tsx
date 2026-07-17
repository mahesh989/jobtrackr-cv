"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode, type ReactElement, type Ref, cloneElement, isValidElement } from "react";

const variantClass = {
  default: "gh-btn",
  primary: "gh-btn gh-btn-primary",
  blue: "gh-btn gh-btn-blue",
  danger: "gh-btn gh-btn-danger",
} as const;

const sizeClass = {
  sm: "text-[12px] px-3 py-1.5",
  md: "text-[13px]",
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
