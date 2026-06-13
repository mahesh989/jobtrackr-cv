"""
Prompt variants for the eval harness (W2, W4 — and any future writer).

Each module here exports a `*_SYSTEM` (and optionally a `*_USER_TEMPLATE`) so a
writer in `services/eval/writers.py` can swap it in without touching the
production prompts in `services/ai/prompts/`.
"""
