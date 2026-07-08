"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { SidebarNav } from "@/components/SidebarNav";

interface Profile {
  id: string;
  name: string;
  newCount: number;
  isRunning: boolean;
}

/**
 * Mobile navigation drawer. The desktop sidebar is hidden below `md`, so on
 * phones this provides the only way to navigate. The hamburger lives in the
 * mobile top bar; tapping it slides in a left drawer that renders the SAME
 * <SidebarNav> as the desktop rail (no nav duplication).
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

  // Close the drawer whenever the route changes (a nav item was tapped).
  // Compared during render (React's "adjusting state when a prop changes"
  // pattern) rather than in an effect — a conditional setState call during
  // render is tracked by React and safely discardable with a thrown-away
  // render under concurrent rendering.
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

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="p-1.5 -ml-1.5 rounded-md text-text-2 hover:text-text hover:bg-[var(--surface-2)] transition-colors"
        aria-label="Open navigation menu"
        aria-expanded={open}
      >
        <Menu className="w-5 h-5" />
      </button>

      {open && (
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
            <SidebarNav
              email={email}
              profiles={profiles}
              poolCount={poolCount}
              role={role}
              userView={userView}
            />
          </div>
        </div>
      )}
    </>
  );
}
