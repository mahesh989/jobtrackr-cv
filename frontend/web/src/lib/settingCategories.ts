// Canonical work-setting taxonomy (Migration 078) for the web UI.
// Keys MUST match backend/worker/src/ai/settingClassifier.ts and the values
// stored in jobs.setting_category / global_jobs.setting_category.

export const SETTING_CATEGORIES = [
  "hospital_clinical",
  "residential_aged_care",
  "home_community",
  "other",
] as const;

export type SettingCategory = (typeof SETTING_CATEGORIES)[number];

export interface SettingCategoryMeta {
  key: SettingCategory;
  label: string;      // short chip label
  description: string; // helper text in the profile filter
}

// Ordered for display. "other" is last — the indeterminate / safety bucket.
export const SETTING_CATEGORY_META: SettingCategoryMeta[] = [
  {
    key: "hospital_clinical",
    label: "Hospital & clinical",
    description: "Hospitals, wards, day surgery, GP practices, clinics, dialysis.",
  },
  {
    key: "residential_aged_care",
    label: "Residential aged care",
    description: "Nursing homes / RACF and retirement villages — residents live on-site.",
  },
  {
    key: "home_community",
    label: "Home & community",
    description: "Care in the client's own home, or travelling between clients.",
  },
  {
    key: "other",
    label: "Other / unclear",
    description: "Agency pools or ads that don't state where the work happens.",
  },
];

const META_BY_KEY = new Map(SETTING_CATEGORY_META.map((m) => [m.key, m]));

export function settingLabel(cat: string | null | undefined): string | null {
  if (!cat) return null;
  return META_BY_KEY.get(cat as SettingCategory)?.label ?? null;
}

// Tailwind chip classes per category (kept here so cards + filters agree).
export const SETTING_CHIP_CLASS: Record<SettingCategory, string> = {
  hospital_clinical: "bg-sky-50 text-sky-700 ring-sky-600/20",
  residential_aged_care: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  home_community: "bg-amber-50 text-amber-700 ring-amber-600/20",
  other: "bg-slate-100 text-slate-600 ring-slate-500/20",
};
