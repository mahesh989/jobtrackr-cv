/**
 * Theme system for JobTrackr.
 *
 * Five themes total:
 *   - "default"     — original JobTrackr look (dark sidebar, light workspace,
 *                     Sofia Sans + DM Serif Display). Fallback / no class.
 *   - "classic"     — cv-magic's Classic theme (clean light interface
 *                     everywhere, Manrope + Noto Serif).
 *   - "gilded-noir" — cv-magic's Gilded Noir (dark gold luxury).
 *   - "notion"      — cv-magic's Notion (lavender canvas + deep purple).
 *   - "clay"        — cv-magic's Clay (bold cream + hot-pink pop).
 *
 * Themes swap CSS custom properties (--bg, --surface, --text, --brand,
 * --sidebar-*, --radius, --font-sans-active, etc.) via a class on <html>.
 * The choice persists to localStorage under 'jobtrackr-theme'.
 */
export type Theme =
  | "aurora-dark"
  | "aurora-light"
  | "default"
  | "classic"
  | "gilded-noir"
  | "notion"
  | "clay";

export const THEMES: ReadonlyArray<{
  id: Theme;
  name: string;
  description: string;
  preview: { bg: string; surface: string; primary: string; text: string; muted: string };
}> = [
  {
    id: "aurora-dark",
    name: "Aurora Dark",
    description: "Signature ink canvas, teal–violet aurora accent",
    preview: {
      bg: "#0A0D12",
      surface: "#11151C",
      primary: "#19E3C8",
      text: "#EAEEF6",
      muted: "#828DA1",
    },
  },
  {
    id: "aurora-light",
    name: "Aurora Light",
    description: "Luminous twin of Aurora, deep-teal accent",
    preview: {
      bg: "#F6F8FB",
      surface: "#FFFFFF",
      primary: "#0B7D74",
      text: "#0E141B",
      muted: "#667085",
    },
  },
  {
    id: "default",
    name: "Default",
    description: "Dark sidebar, GitHub-style light workspace",
    preview: {
      bg: "#F6F8FA",
      surface: "#FFFFFF",
      primary: "#0969DA",
      text: "#1F2328",
      muted: "#656D76",
    },
  },
  {
    id: "classic",
    name: "Classic",
    description: "Clean light interface",
    preview: {
      bg: "#FFFFFF",
      surface: "#F1F5F9",
      primary: "#3B82F6",
      text: "#0F172A",
      muted: "#64748B",
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
const VALID_IDS = new Set<Theme>(["aurora-dark", "aurora-light", "default", "classic", "gilded-noir", "notion", "clay"]);
const THEMED_CLASSES = ["theme-aurora-dark", "theme-aurora-light", "theme-classic", "theme-gilded-noir", "theme-notion", "theme-clay"];

export function getStoredTheme(): Theme {
  if (typeof window === "undefined") return "aurora-light";
  const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
  if (stored && VALID_IDS.has(stored)) {
    return stored;
  }
  // No saved preference → Aurora Light is the project default. An explicit
  // 'default'/other choice is honoured above; only unset/unrecognised land here.
  return "aurora-light";
}

export function applyTheme(theme: Theme) {
  if (typeof document === "undefined") return;
  if (!VALID_IDS.has(theme)) theme = "default";
  const html = document.documentElement;
  THEMED_CLASSES.forEach((c) => html.classList.remove(c));
  if (theme !== "default") {
    html.classList.add(`theme-${theme}`);
  }
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* localStorage can throw in private mode — non-fatal */
  }
}
