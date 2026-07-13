import type { ReactNode } from "react";

const variantClass = {
  blue: "badge badge-blue",
  green: "badge badge-green",
  red: "badge badge-red",
  amber: "badge badge-amber",
  purple: "badge badge-purple",
  gray: "badge badge-gray",
  teal: "badge badge-teal",
} as const;

export interface BadgeProps {
  variant?: keyof typeof variantClass;
  children: ReactNode;
  className?: string;
}

export function Badge({ variant = "gray", children, className = "" }: BadgeProps) {
  return (
    <span className={`${variantClass[variant]} ${className}`}>
      {children}
    </span>
  );
}
