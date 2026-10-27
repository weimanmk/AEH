"""Adaptive Cognitive Twin Education Harness (AEH) core skeleton.

Step 1 of ``TASKS.md``: a dependency-free, standard-library-only skeleton for
the harness described in ``spec/Adaptive_Cognitive_Twin_Education_Harness_v1.1.md``.

The modules here are deliberately small and explicit so that the hard
invariants (real/simulated isolation, fail-closed curriculum gating, evidence
bound mastery, controlled hypotheses) are testable without any external
service.
"""

from __future__ import annotations

__all__ = [
    "curriculum_gate",
    "twin",
    "memory",
    "hypothesis",
    "diagnosis",
    "exercise",
]

__version__ = "0.1.0"
