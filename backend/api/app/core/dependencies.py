"""
Placeholder. Clerk-based get_current_user removed during the strip.

cv-backend has no public auth surface — it trusts HMAC-signed requests from
JobTrackr. The HMAC verification middleware is added in commit 2c.

This file is intentionally near-empty so existing imports continue to resolve
without dragging in Clerk. Replace with HMAC dependencies in 2c.
"""
from __future__ import annotations
