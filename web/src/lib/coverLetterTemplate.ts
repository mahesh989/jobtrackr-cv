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
  contactDetails: ContactDetails;
  company:        string;
  jobTitle:       string;
  hiringManager:  string;
  body:           string;
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

  return [
    buildContactBlock(contactDetails),
    "",
    dateStr,
    "",
    company,
    hiringManager,
    "",
    `Dear ${hiringManager},`,
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
