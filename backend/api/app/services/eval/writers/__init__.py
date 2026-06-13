"""Tailored-CV writer engine.

This package is the in-progress decomposition of what was a single 5k-line
``writers.py`` module. To keep the split strictly behaviour-preserving, this
barrel re-exports **every** name (public and ``_private``) defined by the
implementation, so every historical
``from app.services.eval.writers import X`` — including the ~50 internals the
test-suite imports — keeps resolving byte-for-byte while functions migrate into
focused submodules.

Do not add logic here. As groups are extracted into submodules, ``_impl`` pulls
them back into its namespace, so this re-export stays complete without edits.
"""
from app.services.eval.writers import _impl as _impl  # noqa: F401

# Mirror the full implementation namespace onto the package. Copying _private
# names too is intentional: the test-suite depends on importing them directly.
for _name in dir(_impl):
    if not _name.startswith("__"):
        globals()[_name] = getattr(_impl, _name)
del _name
