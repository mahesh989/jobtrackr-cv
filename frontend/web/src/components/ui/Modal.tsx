"use client";

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useFocusTrap } from "./useFocusTrap";

const SIZE_MAP = {
  sm: "max-w-md",
  md: "max-w-xl",
  lg: "max-w-2xl",
} as const;

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  className?: string;
  size?: "sm" | "md" | "lg";
}

export function Modal({
  open,
  onClose,
  title,
  children,
  className = "",
  size = "md",
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useFocusTrap(open, panelRef);

  // Escape to close
  useEffect(() => {
    if (!open) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);

  // Scroll lock
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? "modal-title" : undefined}
        tabIndex={-1}
        className={`relative bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-xl w-full ${SIZE_MAP[size]} flex flex-col max-h-[90vh] outline-none ${className}`}
      >
        {title && (
          <div className="px-5 py-4 border-b border-[var(--border)]">
            <h2 id="modal-title" className="text-lead font-semibold text-[var(--text)]">
              {title}
            </h2>
          </div>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}
