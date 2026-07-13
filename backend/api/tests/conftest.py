"""Test bootstrap: provide dummy Supabase/DB env so importing app modules
(which build a pydantic Settings at import time) doesn't require real secrets."""
import os

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_ANON_KEY", "test")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")

# A dummy HMAC secret so verify_hmac exercises its real path (missing headers →
# 401) instead of the "secret not set → 500" guard, which the route-surface
# test relies on.
os.environ.setdefault("JOBTRACKR_HMAC_SECRET", "test-secret")
