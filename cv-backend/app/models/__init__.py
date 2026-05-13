# Surviving SQLAlchemy models. The pipeline reads these; cv_version + analysis_run
# stay even though we'll write via Supabase service-role in commit 2e (the models
# are still useful as type hints / shape references).
from app.models.cv_version import CVVersion  # noqa: F401
from app.models.analysis_run import AnalysisRun  # noqa: F401
