"use client";

import { useState, type ReactNode } from "react";
import { DisclosureButton } from "./Disclosure";

/**
 * CollapsibleSection — a self-contained Pattern B editor section (mirrors
 * .editor-section in form-patterns.html): a bordered card with a clickable
 * chevron header and a collapsible body. Composes the shared DisclosureButton
 * so the header layout stays single-sourced.
 *
 * Works uncontrolled (defaultOpen) or controlled (open + onOpenChange) so an
 * autosave editor can drive open state from a context if it needs to.
 */
export function CollapsibleSection({
  title, subtitle, meta, defaultOpen = false,
  open: controlledOpen, onOpenChange,
  children, className = "",
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  meta?: ReactNode;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
  className?: string;
}) {
  const [uncontrolled, setUncontrolled] = useState(defaultOpen);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : uncontrolled;
  const toggle = () => {
    if (isControlled) onOpenChange?.(!open);
    else setUncontrolled((o) => !o);
  };

  return (
    <div className={`rounded-lg border border-border bg-surface ${className}`}>
      <DisclosureButton open={open} onToggle={toggle} title={title} subtitle={subtitle} meta={meta} />
      {open && <div className="px-5 pb-4 pt-1">{children}</div>}
    </div>
  );
}
