"""Test bootstrap: provide dummy Supabase/DB env so importing app modules
(which build a pydantic Settings at import time) doesn't require real secrets."""
import os

os.environ.setdefault("SUPABASE_URL", "http://localhost")
os.environ.setdefault("SUPABASE_ANON_KEY", "test")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")
os.environ.setdefault("SUPABASE_DB_URL", "postgresql+asyncpg://u:p@localhost/db")
