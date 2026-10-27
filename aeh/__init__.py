"""Adaptive Cognitive Twin Education Harness (AEH) core skeleton.

Steps 1 and 2 of ``TASKS.md``: a dependency-free, standard-library-only core
for the harness described in
``spec/Adaptive_Cognitive_Twin_Education_Harness_v1.1.md``, plus an offline
synthetic demo session and aggregate-only teacher/guardian reports.  Step 5
adds an independent, frozen evaluation protocol (spec section 19) that keeps
simulated benefit separate from real transfer.  Step 6 adds a host-side
controlled self-evolution skeleton (spec section 27): versioned
config/policy/prompt candidates, isolated frozen-set evaluation, default-deny
approval, synthetic-session canaries with circuit-breaker rollback, and an
append-only audit log without raw student data.  Steps 9-11 add the versioned
curriculum graph/item bank with retrieval-then-gate, the controlled exercise
evolution engine with an isolated simulation lab, and deterministic FSRS
parameter calibration that only ever proposes a parameter candidate for
isolated evaluation and explicit approval.

The modules here are deliberately small and explicit so that the hard
invariants (real/simulated isolation, fail-closed curriculum gating, evidence
bound mastery, controlled hypotheses, no raw data in reports, no self-proving
evaluation) are testable without any external service.
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
    "evaluation",
    "eval_cli",
    "evolution",
    "fsrs_calibration",
    "fsrs_calibration_cli",
]

__version__ = "0.4.0"
