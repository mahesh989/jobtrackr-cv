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
  /** e.g. "Sydney NSW". Appears below company in the employer block when present. */
  companyLocation:  string | null;
  jobTitle:         string;
  /** Real hiring-manager name, or null if unknown. Controls both the employer
   * block (name line omitted when null) and the salutation ("Dear Hiring Manager,"). */
  hiringManager:    string | null;
  body:             string;
}

/** Format user contact block. Name / "Street, Suburb Postcode" / phone / email. */
export function buildContactBlock(cd: ContactDetails): string {
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
  companyLocation,
  jobTitle,
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
  const employerLines = [
    ...(hiringManager ? [hiringManager] : []),
    company,
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
    `RE: ${jobTitle} at ${company}`,
    "",
    body,
    "",
    "Yours sincerely,",
    "",
    contactDetails.name || "[Your Name]",
  ].join("\n");
}
