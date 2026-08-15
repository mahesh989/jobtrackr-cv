import { describe, it, expect } from "vitest";
import { parseSalary } from "./seek.js";

// Regression cover for C29 (AUDIT-REPORT.md #22): parseSalary used to take the
// first two numbers in the label with no period scaling beyond hourly and no
// sanity guard, so it silently pre-empted ai/jdFacts.ts's sanity-checked
// extractTextSalary fallback (both callers only run the fallback when
// salary_min is still null) and wrote garbage straight into the shared global
// bucket. Table transcribed from the audit's own `node -e` reproduction.

describe("parseSalary", () => {
  it("returns {} for no text", () => {
    expect(parseSalary(undefined)).toEqual({});
    expect(parseSalary(null)).toEqual({});
    expect(parseSalary("")).toEqual({});
  });

  it("parses a plain annual range", () => {
    expect(parseSalary("$90,000 - $110,000")).toEqual({ salary_min: 90000, salary_max: 110000 });
  });

  it("REGRESSION: excludes a trailing super/loading percentage from the candidate pool instead of treating it as salary_max", () => {
    // Was {salary_min:120000, salary_max:11.5} — rendered as "$120k–$11.5" on
    // the board chip. The base salary is still real and worth keeping; only
    // the bogus 11.5%-as-max is wrong, so it's excluded rather than the whole
    // pair dropped.
    expect(parseSalary("$120,000 + 11.5% Super")).toEqual({ salary_min: 120000, salary_max: 120000 });
  });

  it("does not let a percentage figure disturb a genuine two-number range", () => {
    // The "+11.5% super" earlier in this repo's own real-world example
    // happened to land on the correct range by accident (super was the THIRD
    // number). Confirm the % exclusion doesn't regress it.
    expect(parseSalary("$110,000 - $130,000 + 11.5% super + bonus"))
      .toEqual({ salary_min: 110000, salary_max: 130000 });
  });

  it("REGRESSION: annualises a daily rate instead of storing the daily figure as-is", () => {
    // Was {salary_min:1200, salary_max:1200} — a ~$312k/yr contractor role
    // stored and sorted as the lowest-paid job on the board.
    expect(parseSalary("$1,200 per day + super")).toEqual({ salary_min: 312000, salary_max: 312000 });
  });

  it("REGRESSION: annualises a monthly rate", () => {
    expect(parseSalary("$8,000 per month")).toEqual({ salary_min: 96000, salary_max: 96000 });
  });

  it("REGRESSION: annualises a weekly rate", () => {
    expect(parseSalary("$2,500 per week")).toEqual({ salary_min: 130000, salary_max: 130000 });
  });

  it("REGRESSION: recognises the abbreviated 'p.h.' hourly form, not just 'per hour'/'hourly'/'/hr'", () => {
    // Was {salary_min:35.5, salary_max:35.5} — "p.h." wasn't in the hourly
    // regex at all, so the rate was stored unscaled.
    expect(parseSalary("$35.50 p.h. + penalties")).toEqual({ salary_min: 73840, salary_max: 73840 });
  });

  it("still recognises the original hourly forms, plus 'an hour' and slash/dot abbreviated punctuation variants", () => {
    expect(parseSalary("$45 per hour")).toEqual({ salary_min: 93600, salary_max: 93600 });
    expect(parseSalary("$45 hourly")).toEqual({ salary_min: 93600, salary_max: 93600 });
    expect(parseSalary("$45/hr")).toEqual({ salary_min: 93600, salary_max: 93600 });
    expect(parseSalary("$45 p/h")).toEqual({ salary_min: 93600, salary_max: 93600 });
    expect(parseSalary("$45 an hour")).toEqual({ salary_min: 93600, salary_max: 93600 });
  });

  it("recognises the punctuated abbreviated daily/weekly/monthly forms", () => {
    expect(parseSalary("$1,200 p.d. + super")).toEqual({ salary_min: 312000, salary_max: 312000 });
    expect(parseSalary("$2,500 p/w")).toEqual({ salary_min: 130000, salary_max: 130000 });
    expect(parseSalary("$8,000 p.m.")).toEqual({ salary_min: 96000, salary_max: 96000 });
  });

  it("sanity guard: a max below the min (misparse) falls back to min rather than reporting a negative-width range", () => {
    expect(parseSalary("$50,000 - $10")).toEqual({ salary_min: 50000, salary_max: 50000 });
  });

  it("known residual, not fixed by this chunk (accepted, see EXECUTION-LOG.md [C29]): a packaging-cap figure ahead of the real base salary is still misread", () => {
    // Fixing this needs semantic understanding of "packaging up to X + Y
    // base" phrasing, out of scope for the two sanity/period guards this
    // chunk adds. Documented so a future reader doesn't assume it's fixed.
    expect(parseSalary("Salary packaging up to $18,550 + $95,000 base"))
      .toEqual({ salary_min: 18550, salary_max: 95000 });
  });

  // C29b (2 independent review rounds): round 1 tried excluding a following
  // "%"-figure (kept, see above) plus abbreviated-form punctuation
  // requirements and a specific enumerated blocklist of "pay"/"bonus"/
  // "commission"/"allowance" following the bare word forms — round 2's
  // review found the enumeration approach is fundamentally incomplete
  // ("incentive"/"retainer"/hyphenated fillers not covered) AND regressed
  // genuine cases ("$45 hourly pay", "$1,500 weekly wage"). Replaced with
  // the structural fix in seek.ts: a magnitude-plausibility gate (mirrors
  // ai/jdFacts.ts's own "hourly rates above $500... are misparses" rule) —
  // the period regexes are simple and unanchored again, matching anywhere,
  // but a match is only trusted if the raw figure is a plausible magnitude
  // for that period. This closes the whole collision CLASS, not a
  // whack-a-mole list of specific words. Every case below is a genuine
  // SEEK-style label, not a contrived string.
  describe("REGRESSION (C29b): a period word/abbreviation appearing in ordinary prose must not scale an implausible-for-that-period figure", () => {
    it("does not treat 'Phone' as the 'ph' hourly abbreviation", () => {
      expect(parseSalary("$80,000 + Super + Car + Phone")).toEqual({ salary_min: 80000, salary_max: 80000 });
    });
    it("does not treat 'phone'/'laptop' prose as an hourly marker on a real range", () => {
      expect(parseSalary("$90,000 - $110,000 + super + phone + laptop"))
        .toEqual({ salary_min: 90000, salary_max: 110000 });
    });
    it("does not treat 'Graphic Designer' as containing the 'ph' hourly abbreviation", () => {
      expect(parseSalary("$75,000 - $85,000 Graphic Designer")).toEqual({ salary_min: 75000, salary_max: 85000 });
    });
    it("does not treat 'telephone' as the 'ph' hourly abbreviation", () => {
      expect(parseSalary("$120,000 + telephone and travel allowance")).toEqual({ salary_min: 120000, salary_max: 120000 });
    });
    it("does not treat 'Physiotherapist' as the 'ph' hourly abbreviation", () => {
      expect(parseSalary("$140,000 Physiotherapist + relocation")).toEqual({ salary_min: 140000, salary_max: 140000 });
    });
    it("does not treat 'equipment' as containing the 'pm' monthly abbreviation", () => {
      expect(parseSalary("$95,000 + vehicle and equipment")).toEqual({ salary_min: 95000, salary_max: 95000 });
    });
    it("does not treat a clock time ('9am-5pm') as the 'pm' monthly abbreviation", () => {
      expect(parseSalary("$65,000-$75,000 + super, Mon-Fri 9am-5pm")).toEqual({ salary_min: 65000, salary_max: 75000 });
    });
    it("does not treat 'PD allowance' (professional development, common in AU nursing/education ads) as the daily abbreviation", () => {
      expect(parseSalary("$85,000 + Super + PD allowance")).toEqual({ salary_min: 85000, salary_max: 85000 });
    });
    it("does not treat '(PM)' (Project Manager) as the monthly abbreviation", () => {
      expect(parseSalary("$110,000 + super, Project Manager (PM)")).toEqual({ salary_min: 110000, salary_max: 110000 });
    });
    it("does not treat 'weekly pay' as the salary itself being a weekly rate", () => {
      expect(parseSalary("$90,000 + super + weekly pay")).toEqual({ salary_min: 90000, salary_max: 90000 });
    });
    it("does not treat 'monthly bonuses' as the salary itself being a monthly rate", () => {
      expect(parseSalary("$100,000 + super + monthly bonuses")).toEqual({ salary_min: 100000, salary_max: 100000 });
    });
    it("does not treat 'monthly commission' as the salary itself being a monthly rate", () => {
      expect(parseSalary("$80,000 - $90,000 + monthly commission")).toEqual({ salary_min: 80000, salary_max: 90000 });
    });
    it("does not treat 'daily site allowance' as the salary itself being a daily rate", () => {
      expect(parseSalary("$110,000 + daily site allowance")).toEqual({ salary_min: 110000, salary_max: 110000 });
    });
    it("does not treat 'paid monthly' as the salary itself being a monthly rate", () => {
      expect(parseSalary("$120,000 package, paid monthly")).toEqual({ salary_min: 120000, salary_max: 120000 });
    });
    it("REGRESSION found in round-2 review: 'monthly incentive' — a word not in the round-1 enumerated blocklist, proving enumeration doesn't scale", () => {
      expect(parseSalary("$85,000 + super + monthly incentive")).toEqual({ salary_min: 85000, salary_max: 85000 });
      expect(parseSalary("$70,000 - $80,000 + monthly incentive")).toEqual({ salary_min: 70000, salary_max: 80000 });
    });
    it("REGRESSION found in round-2 review: a hyphenated filler word defeated the round-1 lookahead's word-count cap", () => {
      expect(parseSalary("$110,000 + weekly on-call allowance")).toEqual({ salary_min: 110000, salary_max: 110000 });
      expect(parseSalary("$100,000 + monthly performance-based bonus")).toEqual({ salary_min: 100000, salary_max: 100000 });
    });
    it("REGRESSION found in round-2 review: 'paid on a monthly basis' — the round-1 lookbehind only matched 'paid ' immediately before the word", () => {
      expect(parseSalary("$120,000 package, paid on a monthly basis")).toEqual({ salary_min: 120000, salary_max: 120000 });
    });
    it("REGRESSION found in round-2 review: round-1's enumeration approach broke genuine 'X pay'/'X wage' phrasings that DO confirm the period", () => {
      expect(parseSalary("$45 hourly pay")).toEqual({ salary_min: 93600, salary_max: 93600 });
      expect(parseSalary("$45 paid hourly")).toEqual({ salary_min: 93600, salary_max: 93600 });
      expect(parseSalary("$1,500 weekly wage")).toEqual({ salary_min: 78000, salary_max: 78000 });
    });
    it("'X rate' confirms the period the same as 'X pay'/'X wage' — all three must scale identically", () => {
      expect(parseSalary("$45 hourly rate")).toEqual({ salary_min: 93600, salary_max: 93600 });
      expect(parseSalary("$1,200 daily rate")).toEqual({ salary_min: 312000, salary_max: 312000 });
      expect(parseSalary("$2,500 weekly rate")).toEqual({ salary_min: 130000, salary_max: 130000 });
      expect(parseSalary("$8,000 monthly rate")).toEqual({ salary_min: 96000, salary_max: 96000 });
    });
    it("still recognises the genuine bare word forms this chunk exists to cover, including period-before-figure order", () => {
      expect(parseSalary("$1,200 daily")).toEqual({ salary_min: 312000, salary_max: 312000 });
      expect(parseSalary("$2,500 weekly")).toEqual({ salary_min: 130000, salary_max: 130000 });
      expect(parseSalary("$8,000 monthly")).toEqual({ salary_min: 96000, salary_max: 96000 });
      expect(parseSalary("Monthly: $8,000")).toEqual({ salary_min: 96000, salary_max: 96000 });
    });

    // C29b round 4 review: evaluating periods in fixed precedence and
    // gating only the TOP match (e.g. hourly checked first) meant a
    // spurious high-precedence collision word (e.g. "Phone" matching the
    // hourly regex) permanently suppressed a genuinely-present, plausible
    // LOWER-precedence period actually written in the same label —
    // reproducing the ORIGINAL C29 failure mode via a different route.
    // Fixed by picking the first PLAUSIBLE period (falling through to the
    // next candidate) instead of the first MATCHING one.
    it("REGRESSION found in round-4 review: an explicit 'per day' must not be shadowed by a coincidental hourly-abbreviation collision earlier in precedence", () => {
      expect(parseSalary("$1,200 per day + phone")).toEqual({ salary_min: 312000, salary_max: 312000 });
      expect(parseSalary("$1,000 per day - locum Physiotherapist")).toEqual({ salary_min: 260000, salary_max: 260000 });
    });
    it("REGRESSION found in round-4 review: an explicit 'per week'/'per month' must not be shadowed the same way", () => {
      expect(parseSalary("$2,500 per week + phone and laptop")).toEqual({ salary_min: 130000, salary_max: 130000 });
      expect(parseSalary("$8,000 per month + car and phone")).toEqual({ salary_min: 96000, salary_max: 96000 });
    });
    it("REGRESSION found in round-4 review: 'daily rate' near an unrelated hourly-abbreviation collision ('Graphic') must still scale daily", () => {
      expect(parseSalary("$1,400 daily rate, Graphic Designer contract")).toEqual({ salary_min: 364000, salary_max: 364000 });
    });
    it("REGRESSION found in round-4 review: the punctuated 'p.d.' form must not be shadowed by an hourly collision in the same label", () => {
      expect(parseSalary("$1,800 p.d. + phone allowance")).toEqual({ salary_min: 468000, salary_max: 468000 });
    });

    // C29b round 5 review: round 4's "first plausible, not first matching"
    // fix closed the shadowing gap only when the shadowing WEAK match itself
    // was implausible (raw figure too high). It did NOT close the case
    // where an everyday AU day-rate ($350-$500/day is routine for
    // trades/admin/locum contract roles) is ALSO plausible AS an hourly
    // rate purely by coincidence of magnitude — so a spurious "ph"/"pd"
    // collision (inside "Phone", bare "daily" following it, etc) could win
    // outright over an explicit, unambiguous marker for a different period,
    // because BOTH candidates passed their own plausibility check and the
    // spurious one simply came first in fixed precedence. Fixed by
    // splitting each period into an unambiguous STRONG form (explicit
    // "per day", bare "daily") checked across all four periods BEFORE any
    // collision-prone WEAK/abbreviated form ("p.d.", bare "ph"/"pd"/"pw"/
    // "pm") gets a chance at all — not just re-ordering within one flat list.
    it("REGRESSION found in round-5 review: an everyday AU day-rate that's ALSO coincidentally plausible-as-hourly must not let a spurious hourly collision win over the explicit 'per day'", () => {
      expect(parseSalary("$450 per day + phone")).toEqual({ salary_min: 117000, salary_max: 117000 });
      expect(parseSalary("$400 per day + super, Graphic Designer")).toEqual({ salary_min: 104000, salary_max: 104000 });
      expect(parseSalary("$380 per day, Physiotherapist locum")).toEqual({ salary_min: 98800, salary_max: 98800 });
      expect(parseSalary("$350 - $450 per day + phone")).toEqual({ salary_min: 91000, salary_max: 117000 });
    });
    it("REGRESSION found in round-5 review: the bare word 'daily rate' (not just the punctuated 'per day') must win over a plausible-but-spurious hourly collision", () => {
      expect(parseSalary("$500 daily rate + phone allowance")).toEqual({ salary_min: 130000, salary_max: 130000 });
    });
    it("REGRESSION found in round-5 review: an ordinary part-time weekly/monthly figure near a 'PD allowance' (daily abbreviation) collision must still resolve to the explicit weekly/monthly period, not the coincidentally-plausible daily one", () => {
      expect(parseSalary("$1,000 per week + PD allowance")).toEqual({ salary_min: 52000, salary_max: 52000 });
      expect(parseSalary("$2,000 per month + PD allowance")).toEqual({ salary_min: 24000, salary_max: 24000 });
    });

    // C29b round 6 review, defect A: round 5's STRONG-tier-before-WEAK-tier
    // split fixed the strong-vs-weak precedence problem, but a fixed
    // H>D>W>M order WITHIN the strong tier had the exact same shadowing bug
    // one level up — when a label genuinely contains TWO different strong
    // markers and the figure is coincidentally plausible for BOTH periods
    // (e.g. "$1,800" is plausible as either a weekly or a daily rate), the
    // higher-precedence one always won regardless of which was actually
    // describing the headline figure. Fixed with proximity: whichever
    // marker sits closest to the number in the raw text wins.
    it("REGRESSION found in round-6 review: an explicit 'per week' next to the figure must win over an unrelated 'daily' marker later in the same label, even though both are plausible for this magnitude", () => {
      expect(parseSalary("$1,800 per week + daily site allowance")).toEqual({ salary_min: 93600, salary_max: 93600 });
      expect(parseSalary("$1,500 per week + daily travel allowance")).toEqual({ salary_min: 78000, salary_max: 78000 });
    });
    it("REGRESSION found in round-6 review: an explicit 'per month' next to the figure must win over an unrelated 'weekly' marker later in the same label", () => {
      expect(parseSalary("$8,000 per month, paid weekly")).toEqual({ salary_min: 96000, salary_max: 96000 });
      expect(parseSalary("$4,000 per month + weekly allowance")).toEqual({ salary_min: 48000, salary_max: 48000 });
    });
    it("REGRESSION found in round-6 review: an explicit 'per day' next to the figure must win over an unrelated 'hourly rate' phrase later in the same label", () => {
      expect(parseSalary("$450 per day, hourly rate negotiable")).toEqual({ salary_min: 117000, salary_max: 117000 });
    });
    it("proximity ranking does not disturb a label where both matches are the SAME period (nothing to disambiguate)", () => {
      expect(parseSalary("$1,200 per day + daily meal allowance")).toEqual({ salary_min: 312000, salary_max: 312000 });
    });

    // C29b round 6 review, defect B: salary_max was derived by scaling `hi`
    // with whatever scale `lo`'s context selected, with no plausibility
    // check of its own — a second, unrelated ALREADY-ANNUAL figure
    // elsewhere in the label (a package cap, a "per annum" confirmation)
    // got multiplied by lo's hourly/daily/etc scale into a nine-figure
    // number. Fixed: if scaling `hi` produces a figure no real AU salary
    // reaches, and `hi` independently looks like a genuine annual amount
    // on its own, `hi` is used unscaled instead.
    it("REGRESSION found in round-6 review: a second already-annual figure ('up to $X package') must not be multiplied by lo's hourly scale", () => {
      expect(parseSalary("$55 per hour, up to $120,000 package")).toEqual({ salary_min: 114400, salary_max: 120000 });
    });
    it("REGRESSION found in round-6 review: a parenthetical 'per annum' confirmation figure must not be multiplied by lo's hourly scale", () => {
      expect(parseSalary("$45 p.h. ($93,600 per annum)")).toEqual({ salary_min: 93600, salary_max: 93600 });
    });
    it("the same figures in reverse order were already safe via the existing max<min sanity guard — confirm the new hi-guard doesn't disturb that", () => {
      expect(parseSalary("$93,000 pa ($45 p.h.)")).toEqual({ salary_min: 93000, salary_max: 93000 });
    });

    // C29b round 7 review: the round-6 hi-guard only rewrote salary_max when
    // `hi >= MIN_PLAUSIBLE_ANNUAL` ($20k) — a CONDITIONAL gate, not a clamp.
    // Any implausible `candidateMax` with a SMALLER `hi` (e.g. a real AU
    // NFP/health salary-packaging cap — $15,900/$18,550 are the actual
    // statutory figures, common in exactly the hourly-quoted roles this
    // scales) passed through completely unguarded, reproducing defect B at
    // full 8-figure scale. Fixed: any implausible candidateMax is always
    // replaced with something safe — `hi` unscaled if it independently
    // looks annual, otherwise fall back to salary_min.
    it("REGRESSION found in round-7 review: a real AU salary-packaging cap below the annual floor must not slip through the hi-guard unclamped", () => {
      expect(parseSalary("$55 per hour + salary packaging up to $18,550")).toEqual({ salary_min: 114400, salary_max: 114400 });
      expect(parseSalary("$45 per hour + $15,900 salary packaging")).toEqual({ salary_min: 93600, salary_max: 93600 });
    });
    it("REGRESSION found in round-7 review: a completion/sign-on bonus figure below the annual floor must not slip through the hi-guard unclamped", () => {
      expect(parseSalary("$1,200 per day + $10,000 completion bonus")).toEqual({ salary_min: 312000, salary_max: 312000 });
      expect(parseSalary("$60 per hour + $5,000 annual training allowance")).toEqual({ salary_min: 124800, salary_max: 124800 });
    });
  });
});
