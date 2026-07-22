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


