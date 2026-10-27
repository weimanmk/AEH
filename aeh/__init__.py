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
isolated evaluation and explicit approval.  Step 12 completes the long-term
twin: an append-only evidence log with a versioned, checkpointed, replayable
inference log; per-KC FSRS memory that ages without ever lowering stability;
Step-11 calibration candidates that take effect only after explicit approval;
and hypothesis sets that evolve with evidence and are bound to the exact twin
version they were derived from.  Step 13 completes the short-term virtual
student population (spec section 6): evidence-constrained generation, behaviour
matching, distinguishable-only splitting, indistinguishable merging, weak /
contradicted / uninformative pruning, an explicit ``unknown`` bucket, fidelity
metrics (spec section 19.3), and session-scoped hypothesis snapshots that can
never be persisted into the long-term twin.  Step 14 adds backward tracing from
the first wrong solution step, an uncertainty-aware probe score, and an explicit
diagnosis-session state machine with burden limits.  Step 15 adds the teaching
policy layer: a fail-closed strategy router, the preview / school / AI / review
daily coordination plan, executable retrieval / spacing / interleaving plans,
and a subject-agnostic KC/evidence/strategy contract with math and physics
examples.  Step 16 adds the storage/service boundaries and the execution state
machine (spec sections 12-13): append-only event stores with idempotency keys
and optimistic concurrency, observed/simulated storage-domain isolation,
profile and frozen version-bundle stores, a review-gated content library, a
frozen-evaluation service, a per-stream write coordinator, and the typed
Harness learning-loop state machine with bounded rework loops and the
failure/degradation branches from spec section 15.3.  Step 17 adds privacy,
safety, minor protection and the metrics dashboards (spec sections 20-21): an
append-only guardian/student consent ledger that fails closed, audience-scoped
retention and deletion propagation across stores with receipts, redacted audit
export with stable digests, and a learning/system/cost metric registry plus a
synthetic cost-estimation interface that is never connected to real billing.

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
    "teaching_strategy",
    "services",
    "privacy",
]

__version__ = "0.9.0"
