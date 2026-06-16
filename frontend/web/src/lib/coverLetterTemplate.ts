/**
 * Shared cover-letter delivery template assembly.
 *
 * Used by /api/jobs/[id]/cover-letter/[letter_id]/download to build the
 * AU-standard letter body that the client renders as a PDF.
 */

export interface ContactDetails {
  name?:     string;
  address?:  string;
  suburb?:   string;
  postcode?: string;
  phone?:    string;
  email?:    string;
}

export interface AssembleLetterInput {
  contactDetails:   ContactDetails;
  company:          string;
  /** Multi-line postal address; newlines preserved. Inserted between company
   * name and city/state in the employer block. Null = omit. */
  companyAddress:   string | null;
  /** e.g. "Sydney NSW". Appears below address in the employer block when present. */
  companyLocation:  string | null;
  /** Real hiring-manager name, or null if unknown. Controls both the employer
   * block (name line omitted when null) and the salutation ("Dear Hiring Manager,"). */
  hiringManager:    string | null;
  body:             string;
}

/** Format user contact block. Name / "Street, Suburb Postcode" / phone / email. */
function buildContactBlock(cd: ContactDetails): string {
  const lines: string[] = [];
  if (cd.name) lines.push(cd.name);

  const addressParts: string[] = [];
  if (cd.address) addressParts.push(cd.address);
  if (cd.suburb) {
    addressParts.push(cd.postcode ? `${cd.suburb} ${cd.postcode}` : cd.suburb);
  } else if (cd.postcode) {
    addressParts.push(cd.postcode);
  }
  if (addressParts.length > 0) lines.push(addressParts.join(" "));

  if (cd.phone) lines.push(cd.phone);
  if (cd.email) lines.push(cd.email);
  return lines.join("\n");
}

/** Assemble the full delivery-ready letter text. Paragraphs separated by blank lines. */
export function assembleLetter({
  contactDetails,
  company,
  companyAddress,
  companyLocation,
  hiringManager,
  body,
}: AssembleLetterInput): string {
  const today = new Date();
  const dateStr = today.toLocaleDateString("en-AU", {
    day:   "numeric",
    month: "long",
    year:  "numeric",
  });

  // Employer block: recipient name above company is AU convention. When the
  // hiring manager is unknown, skip the name line entirely rather than
  // printing the placeholder "Hiring Manager" twice (block + salutation).
  // Employer block order (AU convention, top to bottom):
  //   [Hiring manager name] (only if known — otherwise duplicates the salutation)
  //   Company name
  //   [Street address lines] (preserve internal newlines from the textarea)
  //   [City/state line]
  const addressLines = (companyAddress ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const employerLines = [
    ...(hiringManager ? [hiringManager] : []),
    company,
    ...addressLines,
    ...(companyLocation?.trim() ? [companyLocation.trim()] : []),
  ];

  const greeting = hiringManager ? `Dear ${hiringManager},` : "Dear Hiring Manager,";

  return [
    buildContactBlock(contactDetails),
    "",
    dateStr,
    "",
    ...employerLines,
    "",
    greeting,
    "",
    body,
    "",
    "Yours sincerely,",
    "",
    contactDetails.name || "[Your Name]",
  ].join("\n");
}
