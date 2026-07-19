"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { X } from "lucide-react";
import { SidebarLinks } from "@/components/navigation/SidebarLinks";
import { Button } from "@/components/ui";

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
 */
export function MobileNav({
  email,
  profiles,
  poolCount,
  role,
  userView,
}: {
  email: string;
  profiles: Profile[];
  poolCount: number;
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

  return (
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
        <Button
          type="button"
          onClick={() => setOpen(false)}
          icon={<X className="w-4 h-4" />}
          className="absolute top-4 right-3 z-10 p-1.5 rounded-md text-[var(--sidebar-text-dim)] hover:text-[var(--sidebar-text-hover)] hover:bg-[var(--sidebar-active-bg)] transition-colors"
          aria-label="Close navigation menu"
        />
        <SidebarLinks
          email={email}
          profiles={profiles}
          poolCount={poolCount}
          role={role}
          userView={userView}
        />
      </div>
    </div>
  );
}
