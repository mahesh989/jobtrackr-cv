"use client";

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

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

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof variantClass;
  size?: keyof typeof sizeClass;
  isLoading?: boolean;
  icon?: ReactNode;
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
      ...rest
    },
    ref,
  ) => {
    return (
      <button
        ref={ref}
        className={`${variantClass[variant]} ${sizeClass[size]} ${className}`}
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
