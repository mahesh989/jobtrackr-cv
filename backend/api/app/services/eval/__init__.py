"""
Eval package — writer variants, enforcement, verification, role families.

Historically the isolated beta A/B harness; now ON THE PRODUCTION PATH:
the orchestrator imports run_tailored_cv_w8_verified (the default writer)
from eval.writers, and role_families.py routes every run. The /analyze-eval
harness endpoints remain the beta surface, but this package is NOT safe to
delete or treat as experimental.
"""
