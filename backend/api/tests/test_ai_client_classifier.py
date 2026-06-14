"""Provider-error classification — pure unit tests on the helpers in client.py.

We don't talk to any real provider here; we just feed representative exception
shapes (the strings come straight from real prod failures) into the classifier
and assert the right typed error pops out.
"""
from __future__ import annotations

from app.services.ai.client import (
    AIBillingError,
    AIClientError,
    AIRateLimitError,
    _classify_provider_error,
    _is_billing_error,
    _is_rate_limit_error,
)


# Pulled verbatim from production failure messages.
ANTHROPIC_CREDIT_LOW = (
    "Error code: 400 - {'type': 'error', 'error': {'type': 'invalid_request_error', "
    "'message': 'Your credit balance is too low to access the Anthropic API. "
    "Please go to Plans & Billing to upgrade or purchase credits.'}, "
    "'request_id': 'req_011CbpurB4aMJekRB3vV7kuJ'}"
)
OPENAI_INSUFFICIENT_QUOTA = (
    "Error code: 429 - {'error': {'message': 'You exceeded your current quota, "
    "please check your plan and billing details.', 'type': 'insufficient_quota'}}"
)
OPENAI_RATE_LIMIT = (
    "Error code: 429 - {'error': {'message': 'Rate limit reached for "
    "gpt-4o-mini in organization org-foo on requests per minute (RPM)'}}"
)
ANTHROPIC_OVERLOADED = "Error code: 529 - overloaded_error"
PLAIN_NETWORK = "<ConnectionTerminated error_code:1, last_stream_id:99>"


class TestBillingDetector:
    def test_anthropic_credit_low(self):
        assert _is_billing_error(Exception(ANTHROPIC_CREDIT_LOW))

    def test_openai_insufficient_quota(self):
        assert _is_billing_error(Exception(OPENAI_INSUFFICIENT_QUOTA))

    def test_plain_rate_limit_is_not_billing(self):
        assert not _is_billing_error(Exception(OPENAI_RATE_LIMIT))

    def test_network_error_is_not_billing(self):
        assert not _is_billing_error(Exception(PLAIN_NETWORK))


class TestRateLimitDetector:
    def test_plain_429_is_rate_limit(self):
        assert _is_rate_limit_error(Exception(OPENAI_RATE_LIMIT))

    def test_insufficient_quota_not_classified_as_rate_limit(self):
        # 429 + insufficient_quota = billing, NOT rate-limit — the priority
        # check inside the classifier prevents misroute.
        assert not _is_rate_limit_error(Exception(OPENAI_INSUFFICIENT_QUOTA))

    def test_anthropic_credit_low_not_rate_limit(self):
        assert not _is_rate_limit_error(Exception(ANTHROPIC_CREDIT_LOW))


class TestClassifier:
    def test_anthropic_billing(self):
        err = _classify_provider_error("anthropic", Exception(ANTHROPIC_CREDIT_LOW))
        assert isinstance(err, AIBillingError)
        assert err.provider == "anthropic"
        assert "console.anthropic.com" in err.top_up_url
        assert "Anthropic" in str(err)
        assert "Top up" in str(err)

    def test_openai_billing(self):
        err = _classify_provider_error("openai", Exception(OPENAI_INSUFFICIENT_QUOTA))
        assert isinstance(err, AIBillingError)
        assert err.provider == "openai"
        assert "platform.openai.com" in err.top_up_url
        assert "OpenAI" in str(err)

    def test_openai_rate_limit(self):
        err = _classify_provider_error("openai", Exception(OPENAI_RATE_LIMIT))
        assert isinstance(err, AIRateLimitError)
        assert err.provider == "openai"
        assert "rate-limited" in str(err)

    def test_other_error_falls_back_to_generic(self):
        err = _classify_provider_error("anthropic", Exception(PLAIN_NETWORK))
        assert isinstance(err, AIClientError)
        assert not isinstance(err, (AIBillingError, AIRateLimitError))

    def test_billing_and_rate_limit_subclass_aiclienterror(self):
        # Orchestrator catches AIClientError as the umbrella — subclasses
        # must remain catchable that way even when specific handlers exist.
        for raw in (ANTHROPIC_CREDIT_LOW, OPENAI_RATE_LIMIT):
            assert isinstance(_classify_provider_error("openai", Exception(raw)), AIClientError)
