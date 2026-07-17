/**
 * Shared domain types — single source of truth for the frontend.
 *
 * Every file that previously declared its own ContactDetails, CategorisedSkills,
 * RoleFamily, etc. should import from here instead.
 */

// ── Profile / contact ────────────────────────────────────────────────────────

export interface Project {
  name?:        string;
  url?:         string;
  description?: string;
}

export interface ProfileCredentials {
  ahpra_number?:          string;
  ndis_screening?:        boolean;
  first_aid?:             boolean;
  cpr?:                   boolean;
  medication_competency?: boolean;
  flu_vaccination?:       boolean;
  covid_vaccination?:     boolean;
  white_card?:            boolean;
  forklift_licence?:      string;
  drivers_licence?:       string;
  own_car?:               boolean;
  car_insurance?:         boolean;
  police_check?:          boolean;
  wwcc?:                  boolean;
  wwcc_state?:            string;
  work_rights?:           string;
  work_rights_hours?:     string;
  availability?:          string[];
  show_availability?:     boolean;
}

export const AVAILABILITY_OPTIONS = ["Full Time", "Part Time", "Casual"] as const;

export type RoleFamily = "tech" | "nursing" | "manual" | "general";

export const FAMILY_LABELS: Record<RoleFamily, string> = {
  tech:    "Tech",
  nursing: "Healthcare",
  manual:  "Manual",
  general: "General",
};

export function formatFamilyLabel(f: RoleFamily): string {
  return FAMILY_LABELS[f] ?? f;
}

export interface ContactDetails {
  name?:         string;
  phone?:        string;
  email?:        string;
  address?:      string;
  suburb?:       string;
  postcode?:     string;
  linkedin?:     string;
  github?:       string;
  website?:      string;
  portfolio?:    string;
  other_label?:  string;
  other_url?:    string;
  projects?:     Project[];
  role_families?: RoleFamily[];
  credentials?:  ProfileCredentials;
}

// ── Skill categories ─────────────────────────────────────────────────────────

export type SkillCategory = "technical" | "soft_skills" | "domain_knowledge";

export const SKILL_CATEGORY_ORDER: readonly SkillCategory[] = [
  "technical",
  "soft_skills",
  "domain_knowledge",
] as const;

export const SKILL_CATEGORY_LABELS: Record<SkillCategory, string> = {
  technical:        "Technical",
  soft_skills:      "Soft skills",
  domain_knowledge: "Domain knowledge",
};

export interface CategorisedSkills {
  technical?:        string[];
  soft_skills?:      string[];
  domain_knowledge?: string[];
}

// ── Stories ──────────────────────────────────────────────────────────────────

export interface StoryNumber {
  metric: string;
  value:  string;
}
