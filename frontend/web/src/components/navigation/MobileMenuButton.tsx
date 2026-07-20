"use client";

import { Menu } from "lucide-react";
import { IconButton } from "@/components/ui";

/**
 * Mobile hamburger button — renders immediately without waiting for sidebar
 * data. The drawer content (SidebarNav) is rendered by SidebarData when it
 * resolves. This avoids CLS from the button popping in after Suspense.
 */
export function MobileMenuButton() {
  return (
    <IconButton
      icon={<Menu className="w-5 h-5" />}
      aria-label="Open navigation menu"
      className="-ml-1.5 md:hidden"
      onClick={() => {
        // Dispatch a custom event that MobileNavDrawer listens for.
        window.dispatchEvent(new CustomEvent("open-mobile-nav"));
      }}
    />
  );
}
