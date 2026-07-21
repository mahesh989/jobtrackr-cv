"use client";

import type { ReactNode } from "react";

/**
 * FormRow — lays two or more fields side by side (mirrors .form-row in
 * form-patterns.html: flex, gap 12px, each child flex:1). Stacks vertically
 * on narrow viewports so fields never get crushed on mobile.
 */
export function FormRow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`flex flex-col sm:flex-row gap-3 [&>*]:flex-1 [&>*]:min-w-0 ${className}`}>
      {children}
    </div>
  );
}
