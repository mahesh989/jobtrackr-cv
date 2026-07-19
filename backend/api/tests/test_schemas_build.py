"""Every Pydantic model in app.schemas must fully resolve.

Pydantic v2 defers forward-ref/type resolution until a model is first
instantiated — so a missing import (e.g. `Literal` dropped from a file's
typing import while still used in an annotation) passes the whole test
suite and only 500s in production on the first real request. That exact
bug shipped in the 2026-07 refactor (AnalyzeResponse). model_json_schema()
forces full resolution at test time instead.
"""
import importlib
import inspect
import pkgutil

from pydantic import BaseModel

import app.schemas


def test_all_schema_models_fully_resolve():
    failures = []
    for modinfo in pkgutil.iter_modules(app.schemas.__path__, prefix="app.schemas."):
        mod = importlib.import_module(modinfo.name)
        for name, obj in inspect.getmembers(mod, inspect.isclass):
            if issubclass(obj, BaseModel) and obj.__module__ == modinfo.name:
                try:
                    obj.model_json_schema()
                except Exception as exc:  # noqa: BLE001 — collect all, report together
                    failures.append(f"{modinfo.name}.{name}: {exc}")
    assert not failures, "Schema models failed to resolve:\n" + "\n".join(failures)
