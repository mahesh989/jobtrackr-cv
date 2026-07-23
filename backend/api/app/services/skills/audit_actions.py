"""Skill-audit action classification — service logic for /internal/classify-skills.

Deterministic (no AI call): runs each phrase through the lexicon classify() +
is_noise() and derives the audit `action` shown on the /beta/skills-audit page.
Extracted verbatim from routes/internal/skills.py so the route stays a thin
transport layer.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional


def classify_audit_items(items: List[str], vertical: Optional[str]) -> List[Dict[str, Any]]:
    """Classify each raw phrase and derive its audit action.

    Returns one dict per item with the exact fields ClassifiedSkillItem
    expects: item / category / canonical / is_noise / action.
    """
    from app.services.skills.classifier import classify as lex_classify, is_noise as lex_is_noise

    results: List[Dict[str, Any]] = []
    for item in items:
        c = lex_classify(item, vertical)
        n = lex_is_noise(item)
        if n:
            action = "should_be_stripped"
        elif c and c.is_skill and c.category == "domain_knowledge":
            action = "should_be_care_skills"
        elif c and c.is_skill and c.category == "technical":
            action = "correct_technical"
        elif c and c.is_skill:
            action = "correct"
        else:
            action = "add_to_lexicon"

        results.append({
            "item":      item,
            "category":  c.category if c and c.is_skill else None,
            "canonical": c.canonical if c and c.is_skill else None,
            "is_noise":  n,
            "action":    action,
        })
    return results
