"""C67: _discover_domain's skip-host check computed a "root domain" by
taking the last 2 dot-separated labels of the hostname (`.`.join(parts[-2:])`)
and comparing it against skip_hosts by EXACT match. That works for a plain
2-label TLD ("seek.com" -> last 2 labels = "seek.com", matches). It breaks
for any compound/two-level ccTLD in the skip list — "seek.com.au" needs the
last 3 labels ("seek", "com", "au") to identify itself, but the code only
ever took 2 ("com.au"), which is never in skip_hosts. So seek.com.au (an
Australian job board, explicitly in the skip list because it's not a
company homepage) was never actually skipped, and could be wrongly returned
as the discovered "company domain".
"""
from __future__ import annotations

from app.services.company.researcher import _discover_domain


def test_seek_com_au_is_skipped_not_returned_as_company_domain():
    results = [{"url": "https://www.seek.com.au/job/12345678"}]
    domain = _discover_domain(results, company_domain=None)
    assert domain is None, f"seek.com.au should be skipped, got {domain!r}"


def test_seek_com_au_skipped_even_as_the_bare_domain():
    results = [{"url": "https://seek.com.au/companies/example"}]
    domain = _discover_domain(results, company_domain=None)
    assert domain is None


def test_a_genuine_company_domain_after_a_skipped_result_is_still_found():
    results = [
        {"url": "https://www.seek.com.au/job/12345678"},
        {"url": "https://www.example-care.com.au/careers"},
    ]
    domain = _discover_domain(results, company_domain=None)
    # The URL regex strips a leading "www." before capturing the host.
    assert domain == "example-care.com.au"


def test_plain_two_label_skip_host_still_works():
    results = [{"url": "https://www.linkedin.com/company/example"}]
    domain = _discover_domain(results, company_domain=None)
    assert domain is None


def test_caller_supplied_domain_always_wins():
    domain = _discover_domain([{"url": "https://anything.example"}], company_domain="known.com")
    assert domain == "known.com"
