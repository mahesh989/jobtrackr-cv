/**
 * Re-exports from the canonical shared types.
 *
 * Prefer importing directly from @/lib/types — this file exists only so
 * existing relative imports within features/cv/profile/ keep working.
 */
export type {
  Project,
  ProfileCredentials,
  ContactDetails,
  RoleFamily,
} from "@/lib/types";

export {
  AVAILABILITY_OPTIONS,
  FAMILY_LABELS,
  formatFamilyLabel,
} from "@/lib/types";
