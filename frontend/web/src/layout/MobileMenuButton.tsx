"use client";

import { Menu } from "lucide-react";
import { Button } from "@/ui";

/**
 * Mobile hamburger button — renders immediately without waiting for sidebar
 * data. The drawer content (SidebarNav) is rendered by SidebarData when it
 * resolves. This avoids CLS from the button popping in after Suspense.
 */
export function MobileMenuButton() {
  return (
    <Button
      type="button"
      icon={<Menu className="w-5 h-5" />}
      className="p-1.5 -ml-1.5 rounded-md text-text-2 hover:text-text hover:bg-[var(--surface-2)] transition-colors md:hidden"
      aria-label="Open navigation menu"
      onClick={() => {
        // Dispatch a custom event that MobileNavDrawer listens for.
        window.dispatchEvent(new CustomEvent("open-mobile-nav"));
      }}
    />
  );
}
