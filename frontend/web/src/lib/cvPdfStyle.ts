/**
 * Print/PDF stylesheet for the tailored CV preview.
 * Ported verbatim from cv-magic so the rendered Preview, Print window,
 * and html2pdf output are all visually identical.
 *
 * A4 + 0.5in margins + Helvetica + section-aware two-column rows
 * (created at render time by applyCvSectionLayout in cvMarkdownHelpers.ts).
 */
export const CV_PDF_STYLE = `
  @page {
    size: A4;
    margin: 0.5in;
  }

  html, body {
    margin: 0;
    padding: 0;
    background: #fff;
  }

  body {
    width: auto;
    color: #000000;
    font-family: Helvetica, Calibri, Arial, sans-serif;
    font-size: 10pt;
    line-height: 11pt;
  }

  * { box-sizing: border-box; }

  .cv-root,
  .cv-root * {
    font-family: Helvetica, Calibri, Arial, sans-serif;
  }

  .cv-root {
    width: 100%;
    color: #000000;
  }

  .cv-root h1 {
    margin: 0 0 2pt 0;
    text-align: center;
    color: #1a1a1a;
    font-size: 24pt;
    line-height: 24pt;
    font-weight: 700;
  }

  .cv-root h1 + p {
    margin: 0;
    text-align: center;
    color: #000000;
    font-size: 10pt;
    line-height: 10pt;
  }

  .cv-root h2 {
    margin: 11.52pt 0 0 0;
    color: #1a1a1a;
    font-size: 10pt;
    line-height: 11pt;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0;
    border: 0;
    padding: 0;
    break-after: avoid;
    break-inside: avoid;
  }

  .cv-root h2::after {
    content: "";
    display: block;
    width: 100%;
    margin-top: 1.44pt;
    border-bottom: 0.5pt solid #000000;
    padding-bottom: 2pt;
  }

  .cv-root h3 {
    margin: 0 0 3pt 0;
    color: #1a1a1a;
    font-size: 10pt;
    line-height: 11pt;
    font-weight: 700;
    break-after: avoid;
    break-inside: avoid;
  }

  .cv-root p {
    margin: 0 0 4pt 0;
    color: #000000;
    font-size: 10pt;
    line-height: 11pt;
    text-align: justify;
    text-justify: inter-word;
  }

  .cv-root ul, .cv-root ol {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .cv-root li {
    margin: 0 0 5.04pt 0;
    padding: 0 0 0 12pt;
    text-indent: -12pt;
    color: #000000;
    line-height: 11pt;
    break-inside: avoid;
  }

  .cv-root li::before {
    content: "•";
    display: inline-block;
    width: 12pt;
    text-indent: 0;
    color: #000000;
  }

  .cv-root li > p {
    margin: 0;
    line-height: 11pt;
    text-align: left;
    color: #000000;
    display: inline;
  }

  .cv-root li > * { margin: 0; color: #000000; }
  .cv-root a       { color: #000080; text-decoration: none; }
  .cv-root strong  { color: #1a1a1a; font-weight: 700; }
  .cv-root em      { font-style: italic; }
  .cv-root h2 + *  { margin-top: 0; }

  .cv-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 1.8in;
    column-gap: 0;
    align-items: baseline;
    margin: 0;
    padding: 0;
    width: 100%;
  }

  .cv-row-left  { min-width: 0; color: #000000; font-size: 10pt; line-height: 11pt; text-align: left; }
  .cv-row-right { color: #000000; font-size: 10pt; line-height: 11pt; text-align: right; white-space: nowrap; }
  .cv-row-right a { color: inherit; text-decoration: none; }
  .cv-row-left a  { color: inherit; text-decoration: none; }

  .cv-row-primary .cv-row-left {
    color: #1a1a1a;
    font-weight: 700;
  }

  .cv-row-secondary .cv-row-left,
  .cv-row-secondary .cv-row-right {
    font-style: italic;
    color: #1a1a1a;
    font-weight: 400;
  }

  .cv-entry {
    margin: 0 0 8.64pt 0;
    break-inside: avoid;
  }

  .cv-entry.cv-entry-education {
    margin: 0 0 6.61pt 0;
  }

  .cv-entry:last-child { margin-bottom: 4pt; }
  .cv-entry ul, .cv-entry ol { margin-top: 3pt; }
  .cv-root > *:last-child { margin-bottom: 0; }

  /* References (and any other) GFM tables — borderless, no padding. */
  .cv-root table {
    width: 100%;
    border-collapse: collapse;
    border: none;
    margin: 0;
    padding: 0;
  }
  .cv-root table th,
  .cv-root table td {
    border: none;
    padding: 2pt 0;
    margin: 0;
    font-size: 10pt;
    line-height: 11pt;
    color: #000000;
    background: transparent;
  }
  .cv-root table thead { display: none; }
`;
