"""Adaptive Cognitive Twin Education Harness (AEH) core skeleton.

Steps 1 and 2 of ``TASKS.md``: a dependency-free, standard-library-only core
for the harness described in
``spec/Adaptive_Cognitive_Twin_Education_Harness_v1.1.md``, plus an offline
synthetic demo session and aggregate-only teacher/guardian reports.

The modules here are deliberately small and explicit so that the hard
invariants (real/simulated isolation, fail-closed curriculum gating, evidence
bound mastery, controlled hypotheses, no raw data in reports) are testable
without any external service.
"""

from __future__ import annotations

__all__ = [
    "curriculum_gate",
    "twin",
    "memory",
    "hypothesis",
    "diagnosis",
    "exercise",
    "report",
    "demo_session",
    "demo",
]

__version__ = "0.2.0"
