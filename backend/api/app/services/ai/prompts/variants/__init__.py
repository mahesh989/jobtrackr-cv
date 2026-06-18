"""
Prompt variants for the eval harness.

Currently only `composition.py` (W3) lives here — it exports
`build_composition_system`, used by the `w8_verified` writer in
`services/eval/writers/`. The earlier W2/W4/W6 comparison prompts have been
removed; production uses W1 (`services/ai/prompts/tailored_cv.py`) on the
legacy path and W3 here on the w8_verified path.
"""
