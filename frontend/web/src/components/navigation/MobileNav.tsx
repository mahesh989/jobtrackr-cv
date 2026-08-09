"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { X } from "lucide-react";
import { SidebarLinks } from "@/components/navigation/SidebarLinks";

interface Profile {
  id: string;
  name: string;
  newCount: number;
  isRunning: boolean;
}

/**
 * Mobile navigation drawer. The hamburger button (MobileMenuButton) renders
 * immediately in the layout top bar. This component renders inside SidebarData
 * (Suspense-wrapped) and listens for the "open-mobile-nav" custom event to
 * open the drawer. This avoids CLS from the button popping in after Suspense.
 *
 * Closes on overlay tap, Escape, and route change. Locks body scroll while open.
 *
 * Portal to document.body — 2026-08-09 fix. This component is a child of
 * Sidebar, which (dashboard)/layout.tsx renders inside ResizableSidebar's
 * `{children}` slot. ResizableSidebar's own wrapper div is `hidden md:flex`
 * (correctly hiding the desktop sidebar chrome below the md breakpoint), but
 * that hid THIS component too — its `fixed inset-0` drawer inherited
 * `display:none` from that ancestor at exactly the widths (<md) where its own
 * `md:hidden` says it should show. The two conditions are inverses of each
 * other, so the drawer could never render at any screen size: opening it
 * (confirmed via direct DOM inspection) updated React state and mounted the
 * drawer correctly, but getBoundingClientRect() on it and every ancestor up to
 * ResizableSidebar's wrapper read 0x0 — display:none propagates to descendants
 * regardless of their own position scheme. A portal is the standard fix for
 * an overlay that must escape an ancestor's visibility/stacking context — it
 * also protects against the more general version of this bug (a future
 * ancestor with `transform`/`filter`/`contain` would make `position: fixed`
 * relative to THAT box instead of the viewport).
 */
export function MobileNav({
  email,
  profiles,
  favouriteCount = 0,
  role,
  userView,
}: {
  email: string;
  profiles: Profile[];
  favouriteCount?: number;
  role?: string;
  userView?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  // Listen for the custom event from MobileMenuButton.
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener("open-mobile-nav", onOpen);
    return () => window.removeEventListener("open-mobile-nav", onOpen);
  }, []);

  // Close the drawer whenever the route changes (a nav item was tapped).
  const [prevPathname, setPrevPathname] = useState(pathname);
  if (prevPathname !== pathname) {
    setPrevPathname(pathname);
    setOpen(false);
  }

  // Escape to close + lock background scroll while the drawer is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  if (!open) return null;

  // document.body always exists here: this is a client component, `open` can
  // only become true from the useEffect above (a client-side event, after
  // hydration), and the server-rendered pass never gets past the `!open`
  // guard above. No SSR/mount guard needed.
  return createPortal(
    <div className="fixed inset-0 z-[9998] md:hidden">
      {/* Dimmed overlay */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={() => setOpen(false)}
        aria-hidden
      />
      {/* Drawer — width matches the desktop sidebar, capped on small phones */}
      <div
        className="absolute inset-y-0 left-0 max-w-[80vw] bg-[var(--sidebar-bg)] border-r border-[var(--sidebar-border)] shadow-xl flex flex-col"
        style={{ width: "var(--sidebar-width)" }}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation menu"
      >
        {/* Close button floated over the drawer's own logo row */}
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="absolute top-4 right-3 z-10 p-1.5 rounded-md text-[var(--sidebar-text-dim)] hover:text-[var(--sidebar-text-hover)] hover:bg-[var(--sidebar-active-bg)] transition-colors"
          aria-label="Close navigation menu"
        >
          <X className="w-4 h-4" />
        </button>
        <SidebarLinks
          email={email}
          profiles={profiles}
          favouriteCount={favouriteCount}
          role={role}
          userView={userView}
        />
      </div>
    </div>,
    document.body,
  );
}
