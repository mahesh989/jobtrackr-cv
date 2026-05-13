# Import all models so Alembic autogenerate can detect them
from app.models.user import User  # noqa: F401
from app.models.user_preference import UserPreference  # noqa: F401
from app.models.company import Company  # noqa: F401
from app.models.cv_version import CVVersion  # noqa: F401
from app.models.analysis_run import AnalysisRun  # noqa: F401
