"""
Eval harness — additive, isolated package for the beta A/B/C/D screen.

Nothing in here is imported by the production pipeline (orchestrator.py).
It REUSES the existing pipeline steps to reproduce each writer variant
faithfully, but never modifies them. Safe to delete wholesale on rollback.
"""
