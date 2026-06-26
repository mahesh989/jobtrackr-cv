"""Shared Education section rules for tailored-CV prompts."""

EDUCATION_EXACT_RULES = """\
## Education – EXACT rules (replace any previous education instructions)

### SECTION HEADER
Use `## Education` exactly. Do not rename.

### ENTRY FORMAT (strict – every entry exactly these two lines)
### Institution Name | Location (city/state/country)

*Full Qualification Name | Start – End*

- Line 1 is an h3 (`###`). Line 2 is a single italic paragraph (`*…*`).
- **Dates:** copy from the source CV. Use short month + year when the source
  includes a month (e.g. `May 2026`, `Dec 2025 – Feb 2026`). Use year only when
  the source has no month (e.g. `2015 – 2019`). Use `Present` for in-progress
  degrees. En-dash with spaces between dates.
- **No bullet points** under any entry. Never.
- **No extra lines** between entries – just a blank line before the next `###`.
- **No qualification codes** – never write `CHC43015`, `HLTAID011`, `BSB50420`,
  or any alphanumeric code. Write only the human-readable name:
  `Certificate IV in Ageing Support`, `Bachelor of Science`, `PhD in Physics`.
- Append `(GPA: X)` to the qualification only when the source CV reports a GPA.

### ORDER (hard rule)
**Sort entries by end date descending** (most recent first).
If two entries have the same end date, sort by start date descending.
If a degree is ongoing (`Present`), it counts as most recent.

### HANDLING MISSING DATES
- If an entry has **no date at all** on the original CV, put it **last** (after
  all dated entries). Use no date placeholder – just omit the date part.
  Example: `*Bachelor of Arts | *` (leave blank after pipe).
- If only a start date exists (no end date), treat end date as `Present` for
  sorting.

### SELECTION – which entries to show

**Step A – Count total entries from original CV** (degrees, diplomas, VET
qualifications).

**Case 1 – 3 or fewer entries total**
Keep all of them **except** you MAY drop one entry if ALL of these are true:
- It is a **PhD or research Master's**.
- The job description does **not** require a PhD or research.
- The candidate has **at least one other** degree that is relevant to the job's
  field.
- Dropping it would **not** leave the Education section empty.

**Case 2 – 4 or more entries total**
Keep **at most 3 entries**. Choose by following this priority order (do not
skip steps):
1. **Must keep** – any degree that the job description explicitly lists as
   "required" or "preferred".
2. **Drop unrelated** – any degree whose subject has **no overlap** with the
   job's domain, required skills, or methodology.
3. **Drop overqualification** – any PhD or research Master's when the job does
   NOT ask for a PhD/research AND the candidate has at least one other relevant
   degree.
4. **Cap to 3** – if still more than 3 entries, keep the 3 with the **highest
   relevance** (best subject match, then most recent).
5. **Safety** – always keep at least 1 relevant degree. If step 2 would drop
   everything, keep the most recent Bachelor's or highest qualification.

### FORBIDDEN PATTERNS (zero tolerance)
❌ Never open the Education section with a bullet list or code line.
❌ Never write `- **Institution | Location**` (bullet format).
❌ Never write `CHC43015 – Certificate IV…` (code before name).
❌ Never write a third line (e.g., `*Relevant coursework: …*`).
❌ Never include a degree that is **completely unrelated** to the job when you
   have 4+ entries (step 2 above).

### EXAMPLES (correct)

**Two entries, most recent first:**
### University of Sydney | Sydney, NSW
*Bachelor of Science (Computer Science) | 2015 – 2019*

### TAFE NSW | Sydney, NSW
*Certificate IV in Ageing Support | May 2020*

**Single entry with missing date (placed last):**
### University of Sydney | Sydney, NSW
*Bachelor of Arts | *

**In-progress degree:**
### University of Melbourne | Melbourne, VIC
*Master of Data Science | Dec 2023 – Present*

### EXAMPLES (forbidden)

❌ **Bullet format:**
- **University of Sydney | Sydney, NSW** *Bachelor of Science | 2015 – 2019*

❌ **Code in name:**
### TAFE NSW | Sydney, NSW
*CHC43015 – Certificate IV in Ageing Support | 2020*

❌ **Extra line / bullet under entry:**
### University of Sydney | Sydney, NSW
*Bachelor of Science | 2015 – 2019*
Graduated with honours

❌ **Out of order (older first):**
### TAFE NSW | Sydney, NSW
*Certificate IV | 2020*

### University of Sydney | Sydney, NSW
*Bachelor of Science | 2015 – 2019*\
"""
