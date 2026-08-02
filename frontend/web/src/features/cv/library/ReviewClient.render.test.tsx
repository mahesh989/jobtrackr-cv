// @vitest-environment jsdom
/**
 * Render behaviour of the CV review editor's sections (Skills, Summary,
 * Experience, Education, Projects, Languages, Awards, Certifications,
 * References, Custom sections, Add-a-section).
 *
 * Companion to ReviewClient.autosave.test.tsx, which pins persistence. These
 * tests exist to make the render block safe to split into per-section
 * components: each pins that a section's fields come from `doc`, that an edit
 * reaches the right patcher (and only that patcher), that opt-in sections
 * show/hide via enableSection/disableSection, and that create-mode validation
 * flags the right fields. A section extraction that swaps a wrong prop, drops
 * a patcher, or renders a stale value should fail one of these.
 *
 * No jest-dom in this repo — assertions use plain DOM properties (.value,
 * .checked, getAttribute) rather than toHaveValue()/toBeInTheDocument().
 *
 * Field labels like "Name", "Location" and "Issuer" repeat across sections
 * (Projects/Awards/References/Certifications all have "Name", etc), so most
 * queries are scoped to their section via sectionFor() + within() rather than
 * queried globally — otherwise they'd throw on the fixture below, which
 * populates every section at once.
 *
 * Written BEFORE the extraction, against the pre-split component.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { StructuredCv } from "@/lib/cv/backend";

// ── module mocks ─────────────────────────────────────────────────────────────
const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  useSearchParams: () => new URLSearchParams(),
}));

import { ReviewClient } from "./ReviewClient";

// ── fixtures ─────────────────────────────────────────────────────────────────
/** A CV with every section populated, so review mode renders all of them
 *  without needing to opt in. */
function fullCv(over: Partial<StructuredCv> = {}): StructuredCv {
  return {
    summary: "Experienced nurse.",
    skills: {
      technical: ["wound care"],
      soft_skills: ["communication"],
      domain_knowledge: ["aged care"],
    },
    experience: [{
      employer: "Acme", role: "Nurse", location: "Sydney",
      start_date: "2020", end_date: "2023", is_current: false,
      bullets: ["Delivered care."],
    }],
    education: [{
      institution: "TAFE", qualification: "Cert III", location: "Melbourne",
      start_date: "2018", end_date: "2019", completed: true,
    }],
    projects: [{ name: "Portfolio site", url: "https://example.com", description: "A site." }],
    languages: [{ language: "English", proficiency: "Native" }],
    awards: [{ name: "Employee of the year", issuer: "Acme", location: "Sydney", date: "2022", description: "Great work." }],
    certifications: [{ name: "CPR", issuer: "Red Cross", code: "CPR-1", issued_date: "2021" }],
    references: [{ name: "Jane Doe", job_title: "Manager", company: "Acme", email: "jane@acme.com" }],
    gaps: [],
    ...over,
  } as unknown as StructuredCv;
}

/** A CV with nothing filled in — what create mode starts from. Optional
 *  sections are opted out, experience/education seeded blank by the
 *  component itself (see ReviewClient's isCreate branch). */
function blankCv(): StructuredCv {
  return {
    summary: "",
    skills: { technical: [], soft_skills: [], domain_knowledge: [] },
    experience: [],
    education: [],
    projects: [],
    languages: [],
    awards: [],
    certifications: [],
    references: [],
    gaps: [],
  } as unknown as StructuredCv;
}

function renderReview(props: Partial<Parameters<typeof ReviewClient>[0]> = {}) {
  return render(
    <ReviewClient
      cvId="cv-1"
      label="my-cv.pdf"
      initialStructuredCv={fullCv()}
      initialStatus="in_review"
      {...props}
    />,
  );
}

/** Section titles are their own leaf <span>, so scoping by { selector: "span" }
 *  avoids matching the same label text on an Add-a-section panel button
 *  (that text sits bare in the button, not wrapped in a span). */
function sectionFor(title: string): HTMLElement {
  return screen.getByText(title, { selector: "span" }).closest("section") as HTMLElement;
}

function value(el: Element): string {
  return (el as HTMLInputElement | HTMLTextAreaElement).value;
}

beforeEach(() => {
  vi.useFakeTimers();
  push.mockClear();
  const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ structured_cv_status: "in_review" }) }));
  vi.stubGlobal("fetch", fetchMock);
  // jsdom doesn't implement scrollTo — saveFinish() calls it unconditionally
  // when validation fails.
  window.scrollTo = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── SKILLS ───────────────────────────────────────────────────────────────────
describe("Skills section", () => {
  it("renders chips from each bucket in the doc", () => {
    renderReview();
    expect(screen.getByText("wound care")).toBeTruthy();
    expect(screen.getByText("communication")).toBeTruthy();
    expect(screen.getByText("aged care")).toBeTruthy();
  });

  it("adding a skill via Enter reaches addSkill and renders the new chip", () => {
    renderReview();
    const input = screen.getByLabelText("Add Skills & tools");
    fireEvent.change(input, { target: { value: "IV therapy" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("iv therapy")).toBeTruthy(); // addSkill lowercases
  });

  it("removing a chip reaches removeSkill", () => {
    renderReview();
    fireEvent.click(screen.getByLabelText("Remove wound care"));
    expect(screen.queryByText("wound care")).toBeNull();
  });

  it("shows the AI-extraction control in create mode", () => {
    renderReview({ mode: "create", initialStructuredCv: blankCv() });
    // Skills starts opted out in create mode with a blank doc — opt in first.
    fireEvent.click(screen.getByRole("button", { name: /Skills/ }));
    expect(screen.getByText("Suggest from experience")).toBeTruthy();
  });

  it("hides the AI-extraction control in review mode", () => {
    renderReview();
    expect(screen.queryByText("Suggest from experience")).toBeNull();
  });

  it("closing the section in create mode clears the doc via disableSection", () => {
    renderReview({ mode: "create", initialStructuredCv: fullCv() });
    fireEvent.click(screen.getByLabelText("Remove Skills section"));
    expect(screen.queryByText("wound care")).toBeNull();
    // Re-enabling starts from an empty bucket, proving the doc was cleared,
    // not just hidden.
    fireEvent.click(screen.getByRole("button", { name: /Skills/ }));
    expect(screen.queryByText("wound care")).toBeNull();
  });
});

// ── SUMMARY ──────────────────────────────────────────────────────────────────
describe("Summary section", () => {
  it("renders the doc's summary text", () => {
    renderReview();
    expect(screen.getByDisplayValue("Experienced nurse.")).toBeTruthy();
  });

  it("editing the textarea updates the doc", () => {
    renderReview();
    fireEvent.change(screen.getByDisplayValue("Experienced nurse."), { target: { value: "Updated summary." } });
    expect(screen.getByDisplayValue("Updated summary.")).toBeTruthy();
  });

  it("is not rendered in create mode", () => {
    renderReview({ mode: "create", initialStructuredCv: blankCv() });
    expect(screen.queryByText("Profile summary")).toBeNull();
  });
});

// ── EXPERIENCE ───────────────────────────────────────────────────────────────
describe("Experience section", () => {
  it("renders employer, role, location and dates from the doc", () => {
    renderReview();
    const exp = within(sectionFor("Experience"));
    expect(value(exp.getByLabelText(/^Employer/))).toBe("Acme");
    expect(value(exp.getByLabelText(/^Role/))).toBe("Nurse");
    expect(value(exp.getByLabelText(/^Location/))).toBe("Sydney");
    expect(value(exp.getByLabelText("Start date"))).toBe("2020");
    expect(value(exp.getByLabelText("End date"))).toBe("2023");
  });

  it("editing Role reaches patchExperience without touching Employer", () => {
    renderReview();
    const exp = within(sectionFor("Experience"));
    fireEvent.change(exp.getByLabelText(/^Role/), { target: { value: "Senior Nurse" } });
    expect(value(exp.getByLabelText(/^Role/))).toBe("Senior Nurse");
    expect(value(exp.getByLabelText(/^Employer/))).toBe("Acme");
  });

  it("adding a bullet reaches addBullet and an edit reaches setBullet", () => {
    renderReview();
    const exp = sectionFor("Experience");
    const bulletsBefore = exp.querySelectorAll("textarea").length;
    fireEvent.click(within(exp).getByText("Add bullet"));
    expect(exp.querySelectorAll("textarea").length).toBe(bulletsBefore + 1);

    const bullets = exp.querySelectorAll("textarea");
    fireEvent.change(bullets[bullets.length - 1], { target: { value: "New bullet text" } });
    expect(screen.getByDisplayValue("New bullet text")).toBeTruthy();
  });

  it("removing a bullet reaches removeBullet", () => {
    renderReview({
      initialStructuredCv: fullCv({
        experience: [{
          employer: "Acme", role: "Nurse", location: "Sydney",
          start_date: "2020", end_date: "2023", is_current: false,
          bullets: ["First bullet", "Second bullet"],
        }],
      } as Partial<StructuredCv>),
    });
    fireEvent.click(screen.getAllByLabelText("Remove bullet")[0]);
    expect(screen.queryByDisplayValue("First bullet")).toBeNull();
    expect(screen.getByDisplayValue("Second bullet")).toBeTruthy();
  });

  it("adding a role reaches addExperience and shows Remove role buttons (rendered once length > 1)", () => {
    renderReview();
    const exp = within(sectionFor("Experience"));
    expect(exp.queryByLabelText("Remove role")).toBeNull();
    fireEvent.click(exp.getByText("Add role"));
    expect(exp.getAllByLabelText(/^Employer/)).toHaveLength(2);
    expect(exp.getAllByLabelText("Remove role")).toHaveLength(2);
  });

  it("removing a role reaches removeExperience", () => {
    renderReview();
    const exp = within(sectionFor("Experience"));
    fireEvent.click(exp.getByText("Add role"));
    fireEvent.change(exp.getAllByLabelText(/^Employer/)[1], { target: { value: "Second Employer" } });
    fireEvent.click(exp.getAllByLabelText("Remove role")[0]);
    expect(exp.getAllByLabelText(/^Employer/)).toHaveLength(1);
    expect(value(exp.getByLabelText(/^Employer/))).toBe("Second Employer");
    // Back to a single role — the Remove button disappears entirely.
    expect(exp.queryByLabelText("Remove role")).toBeNull();
  });

  it("create mode: flags empty required fields red only after Save is attempted", () => {
    renderReview({ mode: "create", initialStructuredCv: blankCv() });
    const exp = within(sectionFor("Experience"));
    expect(exp.getByLabelText(/^Employer/).getAttribute("aria-invalid")).not.toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(exp.getByLabelText(/^Employer/).getAttribute("aria-invalid")).toBe("true");
    expect(exp.getByLabelText(/^Role/).getAttribute("aria-invalid")).toBe("true");
    expect(exp.getByText(/add at least one/)).toBeTruthy();
  });

  it("create mode: flags experience while leaving a valid education unflagged", () => {
    // The two sections take different error functions (expFieldErr /
    // eduFieldErr). On a wholly blank CV both say "invalid" for every field,
    // so swapping them is invisible — this case makes them disagree.
    renderReview({
      mode: "create",
      initialStructuredCv: {
        ...blankCv(),
        education: [{
          institution: "TAFE", qualification: "Cert III", location: "",
          start_date: "2018", end_date: "", completed: true,
        }],
      } as unknown as StructuredCv,
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(within(sectionFor("Experience")).getByLabelText(/^Employer/).getAttribute("aria-invalid")).toBe("true");
    expect(within(sectionFor("Education")).getByLabelText(/^Institution/).getAttribute("aria-invalid")).not.toBe("true");
  });

  it("create mode: a role with real content is not flagged once it's complete", async () => {
    renderReview({
      mode: "create",
      initialStructuredCv: {
        ...blankCv(),
        experience: [{
          employer: "Acme", role: "Nurse", location: "",
          start_date: "2020", end_date: "", is_current: false,
          bullets: ["Did the job."],
        }],
        education: [{
          institution: "TAFE", qualification: "Cert III", location: "",
          start_date: "2018", end_date: "", completed: true,
        }],
      } as unknown as StructuredCv,
    });
    // saveFinish awaits persist() before navigating, so the click has to be
    // flushed inside act — a bare fireEvent asserts before the promise settles.
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Save" })); });
    const exp = within(sectionFor("Experience"));
    expect(exp.getByLabelText(/^Employer/).getAttribute("aria-invalid")).not.toBe("true");
    expect(push).toHaveBeenCalledWith(expect.stringContaining("/cv#cv-cv-1"));
  });
});

// ── EDUCATION ────────────────────────────────────────────────────────────────
describe("Education section", () => {
  it("renders institution and qualification from the doc", () => {
    renderReview();
    const edu = within(sectionFor("Education"));
    expect(value(edu.getByLabelText(/^Institution/))).toBe("TAFE");
    expect(value(edu.getByLabelText(/^Qualification/))).toBe("Cert III");
  });

  it("editing Qualification reaches patchEducation", () => {
    renderReview();
    const edu = within(sectionFor("Education"));
    fireEvent.change(edu.getByLabelText(/^Qualification/), { target: { value: "Diploma" } });
    expect(value(edu.getByLabelText(/^Qualification/))).toBe("Diploma");
  });

  it("toggling Completed reaches patchEducation", () => {
    renderReview();
    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(false);
  });

  it("shows the moved-from-certifications badge when the flag is set", () => {
    renderReview({
      initialStructuredCv: fullCv({
        education: [{
          institution: "TAFE", qualification: "Cert III", location: "Sydney",
          start_date: "2018", end_date: "2019", completed: true,
          _moved_from_certifications: true,
        }],
      } as Partial<StructuredCv>),
    });
    expect(screen.getByText("Moved here from certifications")).toBeTruthy();
  });

  it("adding then removing an education entry reaches addEducation/removeEducation", () => {
    renderReview();
    const edu = within(sectionFor("Education"));
    fireEvent.click(edu.getByText("Add education"));
    expect(edu.getAllByLabelText(/^Institution/)).toHaveLength(2);
    fireEvent.click(edu.getAllByLabelText("Remove education")[0]);
    expect(edu.getAllByLabelText(/^Institution/)).toHaveLength(1);
  });

  it("create mode: flags empty institution/qualification red only after Save, and never flags dates", () => {
    renderReview({ mode: "create", initialStructuredCv: blankCv() });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    const edu = within(sectionFor("Education"));
    expect(edu.getByLabelText(/^Institution/).getAttribute("aria-invalid")).toBe("true");
    expect(edu.getByLabelText(/^Qualification/).getAttribute("aria-invalid")).toBe("true");
    // Education's DatesField never receives an `invalid` prop — unlike Experience.
    expect(edu.queryByText(/Dates.*required/)).toBeNull();
  });
});

// ── PROJECTS (opt-in, data-gated in review mode) ────────────────────────────
describe("Projects section", () => {
  it("review mode: shown when the doc has projects, edit reaches patchProject", () => {
    renderReview();
    const proj = within(sectionFor("Projects"));
    expect(value(proj.getByLabelText(/^Name/))).toBe("Portfolio site");
    fireEvent.change(proj.getByLabelText(/^Name/), { target: { value: "New name" } });
    expect(value(proj.getByLabelText(/^Name/))).toBe("New name");
  });

  it("review mode: hidden when the doc has no projects", () => {
    renderReview({ initialStructuredCv: fullCv({ projects: [] } as Partial<StructuredCv>) });
    expect(screen.queryByText("Projects")).toBeNull();
  });

  it("create mode: hidden until enabled, then seeded with one empty project via addProject", () => {
    renderReview({ mode: "create", initialStructuredCv: blankCv() });
    expect(screen.queryByText("Projects", { selector: "span" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Projects/ }));
    expect(value(screen.getByLabelText(/^Name/))).toBe("");
  });

  it("create mode: closing the section reaches disableSection and clears projects", () => {
    renderReview({ mode: "create", initialStructuredCv: fullCv() });
    fireEvent.click(screen.getByLabelText("Remove Projects section"));
    expect(screen.queryByText("Portfolio site")).toBeNull();
  });
});

// ── LANGUAGES (opt-in, always shown in review mode) ─────────────────────────
describe("Languages section", () => {
  it("review mode: renders even with no languages (unlike Projects)", () => {
    renderReview({ initialStructuredCv: fullCv({ languages: [] } as Partial<StructuredCv>) });
    expect(screen.getByText("Languages")).toBeTruthy();
  });

  it("editing Proficiency reaches patchLanguage", () => {
    renderReview();
    const lang = within(sectionFor("Languages"));
    fireEvent.change(lang.getByLabelText(/^Proficiency/), { target: { value: "Fluent" } });
    expect(value(lang.getByLabelText(/^Proficiency/))).toBe("Fluent");
  });

  it("adding then removing a language reaches addLanguage/removeLanguage", () => {
    renderReview();
    const lang = within(sectionFor("Languages"));
    fireEvent.click(lang.getByText("Add language"));
    expect(lang.getAllByLabelText(/^Language/)).toHaveLength(2);
    fireEvent.click(lang.getAllByLabelText("Remove language")[1]);
    expect(lang.getAllByLabelText(/^Language/)).toHaveLength(1);
  });
});

// ── AWARDS (opt-in, always shown in review mode) ────────────────────────────
describe("Awards section", () => {
  it("editing Issuer reaches patchAward", () => {
    renderReview();
    const awards = within(sectionFor("Awards"));
    fireEvent.change(awards.getByLabelText(/^Issuer/), { target: { value: "New issuer" } });
    expect(value(awards.getByLabelText(/^Issuer/))).toBe("New issuer");
  });

  it("adding then removing an award reaches addAward/removeAward", () => {
    renderReview();
    const awards = within(sectionFor("Awards"));
    fireEvent.click(awards.getByText("Add award"));
    expect(awards.getAllByLabelText(/^Name/).length).toBe(2);
    fireEvent.click(awards.getAllByLabelText("Remove award")[0]);
    expect(awards.getAllByLabelText(/^Name/).length).toBe(1);
  });
});

// ── CERTIFICATIONS (opt-in OR data-gated, only section with this OR) ───────
describe("Certifications section", () => {
  it("review mode: hidden when the doc has none", () => {
    renderReview({ initialStructuredCv: fullCv({ certifications: [] } as Partial<StructuredCv>) });
    expect(screen.queryByText("Certifications & licences")).toBeNull();
  });

  it("editing Code reaches patchCert without touching Name", () => {
    renderReview();
    const certs = within(sectionFor("Certifications & licences"));
    fireEvent.change(certs.getByLabelText(/^Code/), { target: { value: "CPR-2" } });
    expect(value(certs.getByLabelText(/^Code/))).toBe("CPR-2");
    // Asserting the sibling too: a Code field wired to `name` would read its
    // own write back and look correct without this.
    expect(value(certs.getByLabelText(/^Name/))).toBe("CPR");
  });

  it("create mode: opting in via the Add-a-section panel seeds one empty row via addCertification", () => {
    renderReview({ mode: "create", initialStructuredCv: blankCv() });
    expect(screen.queryByText("Certifications & licences")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Certifications/ }));
    expect(value(screen.getByLabelText(/^Name/))).toBe("");
  });
});

// ── REFERENCES (review mode only) ───────────────────────────────────────────
describe("References section", () => {
  it("renders referee fields from the doc", () => {
    renderReview();
    const refs = within(sectionFor("References"));
    expect(value(refs.getByLabelText(/^Name/))).toBe("Jane Doe");
    expect(value(refs.getByLabelText(/^Email/))).toBe("jane@acme.com");
  });

  it("editing Company reaches patchReferee", () => {
    renderReview();
    const refs = within(sectionFor("References"));
    fireEvent.change(refs.getByLabelText(/^Company/), { target: { value: "New Co" } });
    expect(value(refs.getByLabelText(/^Company/))).toBe("New Co");
  });

  it("adding then removing a referee reaches addReferee/removeReferee", () => {
    renderReview();
    const refs = within(sectionFor("References"));
    fireEvent.click(refs.getByText("Add referee"));
    expect(refs.getAllByLabelText(/^Name/)).toHaveLength(2);
    fireEvent.click(refs.getAllByLabelText("Remove referee")[0]);
    expect(refs.getAllByLabelText(/^Name/)).toHaveLength(1);
  });

  it("is not rendered in create mode", () => {
    renderReview({ mode: "create", initialStructuredCv: blankCv() });
    expect(screen.queryByText("References", { selector: "span" })).toBeNull();
  });
});

// ── CUSTOM SECTIONS (create mode only) ──────────────────────────────────────
describe("Custom sections", () => {
  function addCustomSectionNamed(name: string) {
    fireEvent.click(screen.getByText("Custom section"));
    const nameInput = screen.getByLabelText("Section name");
    fireEvent.change(nameInput, { target: { value: name } });
    fireEvent.keyDown(nameInput, { key: "Enter" });
  }

  it("is not offered in review mode", () => {
    renderReview();
    expect(screen.queryByText("Custom section")).toBeNull();
  });

  it("create mode: adding a custom section renders its title and one empty field", () => {
    renderReview({ mode: "create", initialStructuredCv: blankCv() });
    addCustomSectionNamed("Volunteering");
    expect(screen.getByText("Volunteering")).toBeTruthy();
    expect(value(screen.getByLabelText("Field label"))).toBe("");
  });

  it("editing a custom field reaches patchCustomField", () => {
    renderReview({ mode: "create", initialStructuredCv: blankCv() });
    addCustomSectionNamed("Volunteering");
    fireEvent.change(screen.getByLabelText("Field label"), { target: { value: "Role" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "Shelter volunteer" } });
    expect(value(screen.getByLabelText("Field label"))).toBe("Role");
    expect(value(screen.getByLabelText("Value"))).toBe("Shelter volunteer");
  });

  it("adding and removing a field reaches addCustomField/removeCustomField", () => {
    renderReview({ mode: "create", initialStructuredCv: blankCv() });
    addCustomSectionNamed("Volunteering");
    fireEvent.click(screen.getByText("Add field"));
    expect(screen.getAllByLabelText("Field label")).toHaveLength(2);
    fireEvent.click(screen.getAllByLabelText("Remove field")[0]);
    expect(screen.getAllByLabelText("Field label")).toHaveLength(1);
  });

  it("closing the section reaches removeCustomSection", () => {
    renderReview({ mode: "create", initialStructuredCv: blankCv() });
    addCustomSectionNamed("Volunteering");
    fireEvent.click(screen.getByLabelText("Remove Volunteering section"));
    expect(screen.queryByText("Volunteering")).toBeNull();
  });
});

// ── ADD-A-SECTION panel ──────────────────────────────────────────────────────
describe("Add-a-section panel", () => {
  it("is not rendered in review mode", () => {
    renderReview();
    expect(screen.queryByText("Add a section")).toBeNull();
  });

  it("create mode: lists only the optional sections not yet enabled", () => {
    renderReview({ mode: "create", initialStructuredCv: blankCv() });
    const panel = within(screen.getByText("Add a section").parentElement as HTMLElement);
    expect(panel.getByRole("button", { name: /Skills/ })).toBeTruthy();
    expect(panel.getByRole("button", { name: /Projects/ })).toBeTruthy();

    fireEvent.click(panel.getByRole("button", { name: /Skills/ }));
    expect(panel.queryByText("Skills")).toBeNull();
  });
});
