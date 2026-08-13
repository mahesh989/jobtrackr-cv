"""
Regression test for #14 (audit, execution chunk C52): the "no longer
available/open/active" expiry pattern was unanchored — unlike every other
pattern in _EXPIRY_PATTERNS, which all require the SUBJECT to be the job
itself ("this job/role/position/posting/vacancy ..."), this one matched
"no longer available/open/active" appearing ANYWHERE in the JD text,
regardless of what the sentence was actually talking about. Real, live JDs
routinely say things like "visa sponsorship is no longer available" or
"remote work is no longer available for this role" — none of which mean
the job posting itself is closed. detect_jd_expiry() hard-fails the whole
pipeline run with no override when it fires (jd_expiry.py's own docstring:
"only literal, unambiguous phrases trigger the check" — this one wasn't),
so a live, open JD with an unrelated "no longer available" mention was
silently rejected before any AI step ran.
"""
from __future__ import annotations

from app.services.pipeline.jd_expiry import detect_jd_expiry

LIVE_JD_SPONSORSHIP = """
Registered Nurse — Acute Care Ward

We are seeking an experienced Registered Nurse to join our acute care team.

Please note: visa sponsorship is no longer available for this position.
Applicants must already hold full working rights in Australia.

To apply, submit your resume and cover letter via the link below.
"""

LIVE_JD_REMOTE_WORK = """
Software Engineer — Backend

Join our growing engineering team building scalable APIs.

Due to team restructuring, remote work is no longer available for this
role — all staff are required to work from our Sydney office 5 days/week.

We offer a competitive salary and a supportive team culture.
"""

LIVE_JD_CAR_PARK = """
Administration Assistant

A great opportunity for an organised administrator to join our office.

Please note that on-site parking is no longer available; the nearest
public car park is a 5-minute walk from our building.

Apply now to join our friendly team.
"""

CLOSED_JD_POSITION = """
Registered Nurse — Acute Care Ward

We are seeking an experienced Registered Nurse to join our acute care team.

Update: this position is no longer available. We have filled this role
and are no longer accepting further applications.
"""


def test_REGRESSION_does_not_flag_a_live_jd_with_unrelated_no_longer_available_mention():
    assert detect_jd_expiry(LIVE_JD_SPONSORSHIP) is None


def test_REGRESSION_does_not_flag_a_live_jd_mentioning_remote_work_no_longer_available():
    assert detect_jd_expiry(LIVE_JD_REMOTE_WORK) is None


def test_REGRESSION_does_not_flag_a_live_jd_mentioning_unrelated_amenity_no_longer_available():
    assert detect_jd_expiry(LIVE_JD_CAR_PARK) is None


def test_still_flags_a_genuinely_closed_position():
    reason = detect_jd_expiry(CLOSED_JD_POSITION)
    assert reason is not None
    assert "no longer available" in reason.lower()


def test_empty_jd_text_returns_none():
    assert detect_jd_expiry("") is None
    assert detect_jd_expiry(None) is None  # type: ignore[arg-type]


def test_other_existing_expiry_patterns_are_unaffected():
    """Sanity/regression check: the fix must not touch the other 8 patterns."""
    assert detect_jd_expiry("This job has now closed.") is not None
    assert detect_jd_expiry("Applications are no longer being accepted.") is not None
    assert detect_jd_expiry("We are no longer accepting applications for this role.") is not None
    assert detect_jd_expiry("This job posting has expired.") is not None
    assert detect_jd_expiry("Position has been filled.") is not None
    assert detect_jd_expiry("Recruitment for this role is closed.") is not None
    assert detect_jd_expiry("Vacancy closed as of yesterday.") is not None
    assert detect_jd_expiry("Applications closed on Friday.") is not None
    assert detect_jd_expiry("We are hiring a Registered Nurse for our team.") is None
