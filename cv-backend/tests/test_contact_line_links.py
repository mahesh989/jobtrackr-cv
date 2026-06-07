"""Contact-line dev/portfolio link gating by role family.

GitHub / Portfolio / Website are developer-and-creative artifacts. They belong
on tech-style CVs, not on nursing / care / manual / cleaning CVs. LinkedIn is
universal and always shows. role_family_id=None (unspecified) shows everything
for backward compatibility with the eval/legacy paths.
"""
from app.services.cv.contact_line import stamp_contact_line, _build_contact_parts


_CONTACT = {
    "name": "Rashmi Poudel",
    "address": "NSW",
    "phone": "0403760681",
    "email": "rashmi@example.com",
    "linkedin": "linkedin.com/in/rashmi",
    "github": "github.com/rashmi",
    "website": "rashmi.dev",
}

_MD = (
    "# Rashmi Poudel\n\n"
    "old contact line\n\n"
    "## Professional Summary\n\n"
    "Care worker.\n"
)


# ---------------------------------------------------------------------------
# _build_contact_parts
# ---------------------------------------------------------------------------

def test_nursing_suppresses_github_and_website():
    parts = _build_contact_parts(_CONTACT, "nursing")
    joined = " | ".join(parts)
    assert "GitHub" not in joined
    assert "Website" not in joined
    assert "Portfolio" not in joined
    # LinkedIn + the basics still present
    assert "LinkedIn" in joined
    assert "0403760681" in joined
    assert "NSW" in joined


def test_manual_and_cleaning_suppress_dev_links():
    for fam in ("manual", "cleaning", "general"):
        joined = " | ".join(_build_contact_parts(_CONTACT, fam))
        assert "GitHub" not in joined, fam
        assert "Website" not in joined, fam
        assert "LinkedIn" in joined, fam


def test_tech_keeps_github_and_website():
    joined = " | ".join(_build_contact_parts(_CONTACT, "tech"))
    assert "GitHub" in joined
    assert "Website" in joined
    assert "LinkedIn" in joined


def test_master_family_keeps_dev_links():
    joined = " | ".join(_build_contact_parts(_CONTACT, "master"))
    assert "GitHub" in joined


def test_none_family_shows_everything_backward_compat():
    """Unspecified family (eval/legacy paths) keeps the pre-change behaviour."""
    joined = " | ".join(_build_contact_parts(_CONTACT, None))
    assert "GitHub" in joined
    assert "Website" in joined


def test_portfolio_preferred_over_website_for_tech():
    cd = dict(_CONTACT, portfolio="rashmi.folio.com")
    joined = " | ".join(_build_contact_parts(cd, "tech"))
    assert "Portfolio" in joined
    assert "Website" not in joined  # portfolio wins when both present


# ---------------------------------------------------------------------------
# stamp_contact_line — end to end
# ---------------------------------------------------------------------------

def test_stamp_nursing_contact_line_has_no_github():
    out = stamp_contact_line(_MD, _CONTACT, "nursing")
    contact_line = out.split("\n")[2]  # H1, blank, contact line
    assert "GitHub" not in contact_line
    assert "Website" not in contact_line
    assert "LinkedIn" in contact_line


def test_stamp_tech_contact_line_keeps_github():
    out = stamp_contact_line(_MD, _CONTACT, "tech")
    assert "GitHub" in out
    assert "Website" in out


def test_stamp_default_unspecified_keeps_github():
    out = stamp_contact_line(_MD, _CONTACT)  # no family arg
    assert "GitHub" in out
