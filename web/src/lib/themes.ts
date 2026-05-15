/**
 * Theme system for JobTrackr — adapted from cv-magic.
 *
 * Themes swap CSS custom properties (--sidebar-bg, --bg, --surface, etc.)
 * via a class on the <html> element. Components reference the variables
 * directly (bg-[var(--surface)], text-[var(--text)]) so a single class
 * change repaints the whole app.
 *
 * Classic is the default and matches the original JobTrackr look
 * (GitHub-dark sidebar + light content area). The other three themes
 * are full repaints (sidebar + content + brand colour all swap).
 */
export type Theme = "classic" | "gilded-noir" | "notion" | "clay";

export const THEMES: ReadonlyArray<{
  id: Theme;
  name: string;
  description: string;
  preview: { bg: string; surface: string; primary: string; text: string; muted: string };
}> = [
  {
    id: "classic",
    name: "Classic",
    description: "Dark sidebar, clean light workspace",
    preview: {
      bg: "#F6F8FA",
      surface: "#FFFFFF",
      primary: "#0969DA",
      text: "#1F2328",
      muted: "#656D76",
    },
  },
  {
    id: "gilded-noir",
    name: "Gilded Noir",
    description: "Dark gold luxury",
    preview: {
      bg: "#16130B",
      surface: "#231F17",
      primary: "#F2CA50",
      text: "#EAE1D4",
      muted: "#D0C5AF",
    },
  },
  {
    id: "notion",
    name: "Notion",
    description: "Lavender canvas, deep purple",
    preview: {
      bg: "#E6E0F5",
      surface: "#F4EEFB",
      primary: "#5645D4",
      text: "#0A1530",
      muted: "#5D5B54",
    },
  },
  {
    id: "clay",
    name: "Clay",
    description: "Bold cream, hot-pink pop",
    preview: {
      bg: "#F5F0E0",
      surface: "#FFFAF0",
      primary: "#FF4D8B",
      text: "#0A0A0A",
      muted: "#6A6A6A",
    },
  },
];

const STORAGE_KEY = "jobtrackr-theme";
const VALID_IDS = new Set<Theme>(["classic", "gilded-noir", "notion", "clay"]);

export function getStoredTheme(): Theme {
  if (typeof window === "undefined") return "classic";
  const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
  return stored && VALID_IDS.has(stored) ? stored : "classic";
}

export function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  const html = document.documentElement;
  // Strip any existing theme-* classes and add the chosen one. Classic
  // gets no class at all — :root tokens cover it.
  html.classList.remove("theme-gilded-noir", "theme-notion", "theme-clay");
  if (theme !== "classic") {
    html.classList.add(`theme-${theme}`);
  }
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* localStorage can throw in private mode — non-fatal */
  }
}
