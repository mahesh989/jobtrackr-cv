import type { ReactNode } from "react";

const paddingClass = {
  sm: "p-3",
  md: "p-4",
  lg: "p-6",
} as const;

export interface CardProps {
  children: ReactNode;
  padding?: keyof typeof paddingClass;
  className?: string;
}

export function Card({ children, padding = "md", className = "" }: CardProps) {
  return (
    <div className={`bg-[var(--surface)] border border-[var(--border)] rounded-md ${paddingClass[padding]} ${className}`}>
      {children}
    </div>
  );
}
