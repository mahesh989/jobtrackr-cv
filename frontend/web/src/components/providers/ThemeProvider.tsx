"use client";

import { useEffect } from "react";
import { applyTheme, getStoredTheme } from "@/lib/themes";

/**
 * Mounts inside the dashboard layout and applies the user's saved theme
 * to <html> on first paint. Pairs with the inline FOUC-guard script in
 * <head> (see layout.tsx) — that script runs synchronously to apply the
 * theme class before React hydrates, preventing a flash of the default
 * theme for users on Notion / Clay / Gilded Noir.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    applyTheme(getStoredTheme());
  }, []);
  return <>{children}</>;
}
