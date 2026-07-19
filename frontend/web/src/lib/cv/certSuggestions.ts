/**
 * Maps structured_cv.certifications entries to Credentials checklist keys,
 * so the Credentials tab can suggest ("detected on your CV") which boxes to
 * tick. Suggestion only — never auto-ticks or auto-saves. Deliberately dumb
 * substring/regex matching; false negatives are fine (user just ticks
 * manually), false positives should stay rare given the specific patterns.
 */

const PATTERNS: Record<string, RegExp> = {
  first_aid:               /first aid|HLTAID011|HLTAID003/i,
  cpr:                      /\bcpr\b|HLTAID009/i,
  police_check:             /police check|national police/i,
  ndis_screening:           /ndis/i,
  wwcc:                     /working with children|wwcc/i,
  flu_vaccination:          /influenza|flu vacc/i,
  covid_vaccination:        /covid/i,
  medication_competency:    /medication competenc|medication administration cert/i,
  white_card:               /white card/i,
};

export function suggestCredentialKeys(certs: { name?: string }[]): string[] {
  const found = new Set<string>();
  for (const cert of certs ?? []) {
    const name = cert?.name ?? "";
    if (!name) continue;
    for (const [key, pattern] of Object.entries(PATTERNS)) {
      if (pattern.test(name)) found.add(key);
    }
  }
  return [...found];
}
