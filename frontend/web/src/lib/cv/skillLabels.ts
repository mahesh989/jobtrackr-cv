/**
 * Vertical-aware skill-bucket labels.
 *
 * The structured CV always stores three fixed buckets — `domain_knowledge`,
 * `soft_skills`, `technical` — but the human-facing LABEL for each should match
 * the candidate's sector (their `role_families` from My Details). A nurse sees
 * "Care skills"; a developer sees "Technical skills". The underlying data shape
 * never changes, only the label.
 *
 * Plain module (NO "use client") so both server components (which fetch
 * role_families) and client components (ReviewClient) can import it — see
 * OPS-16 about importing values from "use client" modules into server code.
 */

import type { RoleFamily } from "@/lib/types";
export type { RoleFamily } from "@/lib/types";

export interface SkillLabels {
  domain_knowledge: string;
  soft_skills:      string;
  technical:        string;
}

const LABELS: Record<RoleFamily, SkillLabels> = {
  nursing: { domain_knowledge: "Care skills",       soft_skills: "Soft skills", technical: "Tools & software" },
  tech:    { domain_knowledge: "Domain knowledge",  soft_skills: "Soft skills", technical: "Technical skills" },
  manual:  { domain_knowledge: "Service knowledge", soft_skills: "Soft skills", technical: "Equipment & tools" },
  general: { domain_knowledge: "Domain knowledge",  soft_skills: "Soft skills", technical: "Skills & tools" },
};

export const DEFAULT_SKILL_LABELS: SkillLabels = LABELS.general;

/**
 * Resolve the label set for a user. Picks the first specific (non-"general")
 * family the user selected, falling back to generic labels when none — or only
 * "general" — is chosen.
 */
export function resolveSkillLabels(families: RoleFamily[] | null | undefined): SkillLabels {
  const list = (families ?? []).filter((f): f is RoleFamily => f in LABELS);
  const primary = list.find((f) => f !== "general") ?? "general";
  return LABELS[primary] ?? LABELS.general;
}
