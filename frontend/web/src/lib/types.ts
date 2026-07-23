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
  availability?:          string[];
  show_availability?:     boolean;
}

export type RoleFamily = "tech" | "nursing" | "manual" | "general";

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

export type ToneTarget = "professional" | "warm" | "direct";

// ── Structured CV (post-upload review form) ─────────────────────────────────
// Canonical shapes for cv_versions.structured_cv. Mirror of the Python
// schema in backend/api/app/services/cv/cv_structurizer.py.
export interface StructuredCvSkills {
  technical:        string[];
  soft_skills:      string[];
  domain_knowledge: string[];
}

export interface StructuredCvExperience {
  employer:   string;
  role:       string;
  location:   string;
  start_date: string;
  end_date:   string;
  is_current: boolean;
  bullets:    string[];
}

export interface StructuredCvEducation {
  institution:   string;
  qualification: string;
  location:      string;
  start_date:    string;
  end_date:      string;
  completed:     boolean;
  _moved_from_certifications?: boolean;
}

export interface StructuredCvCertification {
  name:        string;
  issuer:      string;
  code:        string;
  issued_date: string;
}

export interface StructuredCvAward {
  name:        string;
  issuer:      string;
  location:    string;
  date:        string;
  description: string;
}

export interface StructuredCvLanguage {
  language:    string;
  proficiency: string;
}

export interface StructuredCvReferee {
  name:      string;
  job_title: string;
  company:   string;
  email:     string;
}

export interface StructuredCvGap {
  section:     string;
  entry_index: string;
  field:       string;
  message:     string;
}

export interface CustomCvSection {
  id:     string;
  title:  string;
  fields: Array<{ label: string; value: string }>;
}

export interface StructuredCvProject {
  name:        string;
  url:         string;
  description: string;
}

export interface StructuredCv {
  summary:         string;
  experience:      StructuredCvExperience[];
  education:       StructuredCvEducation[];
  awards:          StructuredCvAward[];
  languages:       StructuredCvLanguage[];
  certifications:  StructuredCvCertification[];
  skills:          StructuredCvSkills;
  references:      StructuredCvReferee[];
  gaps:            StructuredCvGap[];
  projects?:       StructuredCvProject[];
  custom_sections?: CustomCvSection[];
  /** Parser-logic version. Server component on the review page silently
   *  re-runs structurize when the stored value is below this constant. Mirror
   *  of backend/api/app/services/cv/cv_structurizer.STRUCTURED_CV_VERSION. */
  _version?:      number;
}

