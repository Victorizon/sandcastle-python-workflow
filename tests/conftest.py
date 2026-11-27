"""Pytest configuration including deterministic container-safe Hypothesis profiles."""

from __future__ import annotations

import os

from hypothesis import settings

settings.register_profile(
    "default",
    max_examples=50,
    derandomize=True,
    deadline=None,
)
settings.register_profile(
    "mutation",
    max_examples=10,
    derandomize=True,
    deadline=None,
)
settings.register_profile(
    "deep",
    max_examples=300,
    derandomize=False,
    deadline=None,
)
settings.load_profile(os.environ.get("HYPOTHESIS_PROFILE", "default"))
