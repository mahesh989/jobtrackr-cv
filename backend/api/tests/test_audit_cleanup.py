"""Audit-cleanup verification tests for the Python backend API.

Ensures the over-engineering audit didn't break imports, config, or routes.
Uses source-file inspection (not runtime imports) where supabase isn't installed.
"""
import os
import importlib

import pytest


def _read_source(module_relpath: str) -> str:
    """Read the source file for a module relative to backend/api/."""
    base = os.path.join(os.path.dirname(__file__), "..")
    path = os.path.join(base, module_relpath)
    with open(path) as f:
        return f.read()


class TestConfigCleanup:
    """Verify config.py no longer requires SUPABASE_DB_URL."""

    def test_settings_loads_without_db_url(self):
        """Settings should instantiate without SUPABASE_DB_URL in env."""
        os.environ.pop("SUPABASE_DB_URL", None)
        from app.config import Settings
        s = Settings()  # type: ignore[call-arg]
        assert s.SUPABASE_URL  # still has the core fields

    def test_settings_has_no_db_url_field(self):
        """SUPABASE_DB_URL should not be a field on Settings."""
        from app.config import Settings
        assert "SUPABASE_DB_URL" not in Settings.model_fields


class TestDatabaseCleanup:
    """Verify database.py no longer imports SQLAlchemy."""

    def test_no_sqlalchemy_in_source(self):
        """database.py source should not mention sqlalchemy."""
        source = _read_source("app/database.py")
        assert "sqlalchemy" not in source.lower()
        assert "AsyncSession" not in source
        assert "DeclarativeBase" not in source
        assert "create_async_engine" not in source

    def test_get_supabase_defined_in_source(self):
        """get_supabase() must be defined in database.py."""
        source = _read_source("app/database.py")
        assert "def get_supabase()" in source

    def test_force_http1_defined_in_source(self):
        """_force_http1 helper must be defined in database.py."""
        source = _read_source("app/database.py")
        assert "def _force_http1(" in source


class TestHealthRoute:
    """Verify health routes don't use SQLAlchemy."""

    def test_health_uses_supabase_not_sqlalchemy(self):
        """health.py should use get_supabase, not AsyncSessionLocal."""
        source = _read_source("app/routes/health.py")
        assert "get_supabase" in source
        assert "AsyncSessionLocal" not in source
        assert "from sqlalchemy" not in source

    def test_health_does_not_import_sqlalchemy(self):
        """health.py should not import sqlalchemy at all."""
        source = _read_source("app/routes/health.py")
        assert "import sqlalchemy" not in source
        assert "from sqlalchemy" not in source


class TestRequirementsCleanup:
    """Verify removed dependencies are gone from requirements.txt."""

    def _read_requirements(self):
        return _read_source("requirements.txt")

    def test_no_sqlalchemy(self):
        assert "sqlalchemy" not in self._read_requirements().lower()

    def test_no_asyncpg(self):
        assert "asyncpg" not in self._read_requirements().lower()

    def test_no_cachetools(self):
        assert "cachetools" not in self._read_requirements().lower()

    def test_no_python_dateutil(self):
        assert "python-dateutil" not in self._read_requirements().lower()

    def test_core_deps_still_present(self):
        reqs = self._read_requirements()
        for dep in ["fastapi", "supabase", "httpx", "pydantic", "anthropic", "openai"]:
            assert dep in reqs.lower(), f"{dep} missing from requirements.txt"


class TestCoreUtilsDeleted:
    """Verify empty husk packages are gone."""

    def test_core_package_deleted(self):
        core_path = os.path.join(os.path.dirname(__file__), "..", "app", "core")
        assert not os.path.isdir(core_path), "app/core/ directory still exists"

    def test_utils_package_deleted(self):
        utils_path = os.path.join(os.path.dirname(__file__), "..", "app", "utils")
        assert not os.path.isdir(utils_path), "app/utils/ directory still exists"

    def test_trust_scorer_fixtures_deleted(self):
        fixtures_path = os.path.join(
            os.path.dirname(__file__), "..", "app", "services", "voice",
            "trust_scorer_fixtures.py"
        )
        assert not os.path.isfile(fixtures_path), "trust_scorer_fixtures.py still exists"
