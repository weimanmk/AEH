"""Tests for the controlled self-evolution pipeline (spec section 27).

Every fixture is synthetic. These tests assert the hard rules: candidates are
versioned declarative change records, cannot touch protected invariants or
production files, are auto-rejected on failed/insufficient evidence, cannot
approve or roll back themselves, and every stage is audited without raw data.
"""

from __future__ import annotations

import unittest
from datetime import datetime, timezone

from aeh.evaluation import (
    SPLIT_EXPLANATION,
    SPLIT_TRAIN,
    SPLIT_TRANSFER,
    EvalItem,
    FrozenEvalSet,
    RealOutcome,
    SimulatedOutcome,
)
from aeh.evolution import (
    ACTION_APPROVAL_RECORDED,
    ACTION_CANARY_CIRCUIT_BREAKER,
    ACTION_CANARY_STARTED,
    ACTION_CANDIDATE_EVALUATED,
    ACTION_CANDIDATE_PROMOTED,
    ACTION_CANDIDATE_REGISTERED,
    ACTION_CANDIDATE_REJECTED,
    ACTION_ROLLBACK_COMPLETED,
    PRODUCTION_MUTATION_ENABLED,
    SANDBOX_HAS_PRODUCTION_ACCESS,
    Actor,
    ApprovalDeniedError,
    ApprovalRecord,
    AuditError,
    AuditLog,
    CanaryConditions,
    CanaryDeniedError,
    CanaryObservation,
    Candidate,
    CandidateRegistry,
    CandidateValidationError,
    DuplicateCandidateError,
    EvolutionControlPlane,
    EvolutionError,
    IsolatedSandbox,
    LifecycleError,
    PromotionPolicy,
    ProtectedInvariantError,
    RollbackDeniedError,
    STATUS_APPROVED,
    STATUS_CANARY,
    STATUS_EVALUATED,
    STATUS_PROMOTED,
    STATUS_PROPOSED,
    STATUS_REJECTED,
    STATUS_ROLLED_BACK,
)

FROZEN_AT = datetime(2026, 3, 1, 0, 0, tzinfo=timezone.utc)
EVAL_AT = datetime(2026, 3, 10, 0, 0, tzinfo=timezone.utc)
DECIDED_AT = datetime(2026, 3, 11, 0, 0, tzinfo=timezone.utc)
OBSERVED_AT = datetime(2026, 3, 5, 0, 0, tzinfo=timezone.utc)

AUTHOR = "system.evolution_agent"
REVIEWER = Actor("reviewer.001", "reviewer")


def make_frozen() -> FrozenEvalSet:
    return FrozenEvalSet(
        dataset_id="aeh.test.evolution",
        version="v1",
        frozen_at=FROZEN_AT,
        items=(
            EvalItem("train.a", "kc.a", SPLIT_TRAIN, 1, True),
            EvalItem("train.b", "kc.a", SPLIT_TRAIN, 2, True),
            EvalItem("explain.a", "kc.a", SPLIT_EXPLANATION, 2, True),
            EvalItem("transfer.a", "kc.a", SPLIT_TRANSFER, 3, False),
            EvalItem("transfer.b", "kc.a", SPLIT_TRANSFER, 4, False),
        ),
    )


def simulated_outcomes(*values: float) -> tuple[SimulatedOutcome, ...]:
    predictions = values or (0.9, 0.6, 0.75)
    return tuple(
        SimulatedOutcome(item_id, value)
        for item_id, value in zip(
            ("train.a", "train.b", "explain.a"), predictions, strict=True
        )
    )


def real_outcomes(correct: bool = True) -> tuple[RealOutcome, ...]:
    return (
        RealOutcome("transfer.a", correct, "trusted_grader", OBSERVED_AT),
        RealOutcome("transfer.b", correct, "trusted_grader", OBSERVED_AT),
    )


def make_candidate(
    *,
    candidate_id: str = "cand.hint_ladder.001",
    version: str = "v1",
    kind: str = "policy",
    source: str = "eval_regression",
    changes: dict | None = None,
    impact_scope: tuple[str, ...] = ("hint_ladder",),
    **overrides,
) -> Candidate:
    return Candidate(
        candidate_id=candidate_id,
        version=version,
        kind=kind,
        source=source,
        change_summary="Reduce hint exposure after the first independent attempt.",
        impact_scope=impact_scope,
        baseline_version="pol-27",
        changes=changes if changes is not None else {"hint_ladder": ["nudge"]},
        created_at=FROZEN_AT,
        author=AUTHOR,
        **overrides,
    )


def make_plane(**kwargs) -> EvolutionControlPlane:
    return EvolutionControlPlane(make_frozen(), now=lambda: EVAL_AT, **kwargs)


def approve(plane: EvolutionControlPlane, candidate: Candidate) -> None:
    plane.approve(
        candidate.candidate_id,
        candidate.version,
        ApprovalRecord(
            candidate_id=candidate.candidate_id,
            candidate_version=candidate.version,
            decision="approved",
            approved_by=REVIEWER.actor_id,
            decided_at=DECIDED_AT,
            reason="synthetic review evidence is sufficient to screen",
            role=REVIEWER.role,
        ),
        REVIEWER,
    )


class CandidateContractTests(unittest.TestCase):
    def test_valid_candidate_is_a_versioned_declarative_record(self):
        candidate = make_candidate()
        self.assertEqual(candidate.key(), ("cand.hint_ladder.001", "v1"))
        self.assertEqual(candidate.mutates_production, False)
        self.assertEqual(candidate.target_files, ())

    def test_unknown_kind_source_and_scope_are_rejected(self):
        with self.assertRaises(CandidateValidationError):
            make_candidate(kind="code_patch")
        with self.assertRaises(CandidateValidationError):
            make_candidate(source="model_invented")
        with self.assertRaises(CandidateValidationError):
            make_candidate(impact_scope=("totally_new_surface",))

    def test_candidate_cannot_lower_gate_or_relax_permissions(self):
        with self.assertRaises(ProtectedInvariantError):
            make_candidate(changes={"curriculum_gate": {"enabled": False}})
        with self.assertRaises(ProtectedInvariantError):
            make_candidate(changes={"security": {"permissions": ["all"]}})
        with self.assertRaises(ProtectedInvariantError):
            make_candidate(impact_scope=("permissions",))
        with self.assertRaises(ProtectedInvariantError):
            make_candidate(changes={"privacy_policy": "off"})

    def test_candidate_cannot_name_production_files_or_mutate_production(self):
        with self.assertRaises(CandidateValidationError):
            make_candidate(target_files=("/etc/passwd",))
        with self.assertRaises(CandidateValidationError):
            make_candidate(mutates_production=True)

    def test_non_declarative_changes_are_rejected(self):
        with self.assertRaises(CandidateValidationError):
            make_candidate(changes={"apply": lambda: None})

    def test_registry_is_append_only_and_idempotent(self):
        audit = AuditLog(now=lambda: EVAL_AT)
        registry = CandidateRegistry(audit)
        candidate = make_candidate()
        first = registry.register(candidate)
        second = registry.register(make_candidate())
        self.assertIs(first, second)
        self.assertEqual(len(registry.list()), 1)
        self.assertEqual(audit.head(), 1)

        with self.assertRaises(DuplicateCandidateError):
            registry.register(
                make_candidate(
                    changes={"hint_ladder": ["different"]},
                )
            )

    def test_fingerprint_changes_when_content_changes(self):
        base = make_candidate()
        changed = make_candidate(changes={"hint_ladder": ["other"]})
        self.assertNotEqual(base.fingerprint(), changed.fingerprint())


class SandboxEvaluationTests(unittest.TestCase):
    def test_simulated_only_evidence_passes_screening_but_not_promotion(self):
        plane = make_plane()
        candidate = plane.propose(make_candidate(), REVIEWER).candidate
        verdict = plane.evaluate(
            candidate.candidate_id,
            candidate.version,
            actor=REVIEWER,
            simulated_outcomes=simulated_outcomes(),
            evaluated_at=EVAL_AT,
        )
        self.assertTrue(verdict.screening_passed)
        self.assertFalse(verdict.promotion_ready)
        self.assertIsNotNone(verdict.simulated_benefit)
        self.assertIsNone(verdict.real_transfer)
        self.assertIn(
            "promotion_blocked:real_transfer_evidence_missing", verdict.reasons
        )
        self.assertEqual(plane.status(candidate.candidate_id, candidate.version), STATUS_EVALUATED)

    def test_no_evidence_auto_rejects_the_candidate(self):
        plane = make_plane()
        candidate = plane.propose(make_candidate(), REVIEWER).candidate
        verdict = plane.evaluate(
            candidate.candidate_id,
            candidate.version,
            actor=REVIEWER,
            evaluated_at=EVAL_AT,
        )
        self.assertFalse(verdict.screening_passed)
        self.assertFalse(verdict.evidence_sufficient)
        self.assertIn(
            "evidence_insufficient:no_simulated_or_real_outcomes", verdict.reasons
        )
        self.assertEqual(
            plane.status(candidate.candidate_id, candidate.version), STATUS_REJECTED
        )
        self.assertTrue(
            plane.audit.entries(action=ACTION_CANDIDATE_REJECTED)
        )

    def test_simulated_gain_below_threshold_auto_rejects(self):
        plane = make_plane(
            policy=PromotionPolicy(min_simulated_gain=0.5)
        )
        candidate = plane.propose(make_candidate(), REVIEWER).candidate
        verdict = plane.evaluate(
            candidate.candidate_id,
            candidate.version,
            actor=REVIEWER,
            simulated_outcomes=simulated_outcomes(0.2, 0.3, 0.1),
            evaluated_at=EVAL_AT,
        )
        self.assertFalse(verdict.screening_passed)
        self.assertIn(
            "screening_failed:simulated_gain_below_threshold", verdict.reasons
        )
        self.assertEqual(
            plane.status(candidate.candidate_id, candidate.version), STATUS_REJECTED
        )

    def test_simulated_outcome_on_transfer_split_is_auto_rejected(self):
        plane = make_plane()
        candidate = plane.propose(make_candidate(), REVIEWER).candidate
        verdict = plane.evaluate(
            candidate.candidate_id,
            candidate.version,
            actor=REVIEWER,
            simulated_outcomes=(SimulatedOutcome("transfer.a", 0.99),),
            evaluated_at=EVAL_AT,
        )
        self.assertFalse(verdict.screening_passed)
        self.assertTrue(
            any("SplitIsolationError" in reason for reason in verdict.reasons)
        )
        self.assertEqual(
            plane.status(candidate.candidate_id, candidate.version), STATUS_REJECTED
        )

    def test_simulated_data_cannot_be_relabelled_as_real(self):
        plane = make_plane()
        candidate = plane.propose(make_candidate(), REVIEWER).candidate
        verdict = plane.evaluate(
            candidate.candidate_id,
            candidate.version,
            actor=REVIEWER,
            real_outcomes=(SimulatedOutcome("transfer.a", 0.95),),
            evaluated_at=EVAL_AT,
        )
        self.assertFalse(verdict.screening_passed)
        self.assertTrue(
            any("SelfProofError" in reason for reason in verdict.reasons)
        )

    def test_real_transfer_above_threshold_marks_promotion_ready(self):
        plane = make_plane()
        candidate = plane.propose(make_candidate(), REVIEWER).candidate
        verdict = plane.evaluate(
            candidate.candidate_id,
            candidate.version,
            actor=REVIEWER,
            simulated_outcomes=simulated_outcomes(),
            real_outcomes=real_outcomes(correct=True),
            evaluated_at=EVAL_AT,
        )
        self.assertTrue(verdict.screening_passed)
        self.assertTrue(verdict.promotion_ready)
        self.assertIsNotNone(verdict.real_transfer)
        self.assertFalse(verdict.real_transfer["causal_claim_supported"])

    def test_real_transfer_below_threshold_is_a_failed_evaluation(self):
        plane = make_plane()
        candidate = plane.propose(make_candidate(), REVIEWER).candidate
        verdict = plane.evaluate(
            candidate.candidate_id,
            candidate.version,
            actor=REVIEWER,
            simulated_outcomes=simulated_outcomes(),
            real_outcomes=real_outcomes(correct=False),
            evaluated_at=EVAL_AT,
        )
        self.assertFalse(verdict.promotion_ready)
        self.assertIn("real_transfer_failed:delta_below_threshold", verdict.reasons)
        self.assertEqual(
            plane.status(candidate.candidate_id, candidate.version), STATUS_REJECTED
        )

    def test_sandbox_has_no_production_access(self):
        self.assertFalse(PRODUCTION_MUTATION_ENABLED)
        self.assertFalse(SANDBOX_HAS_PRODUCTION_ACCESS)
        sandbox = IsolatedSandbox(make_frozen())
        self.assertEqual(sandbox.frozen_set.dataset_id, "aeh.test.evolution")


class ApprovalTests(unittest.TestCase):
    def _evaluated(self) -> tuple[EvolutionControlPlane, Candidate]:
        plane = make_plane()
        candidate = plane.propose(make_candidate(), REVIEWER).candidate
        plane.evaluate(
            candidate.candidate_id,
            candidate.version,
            actor=REVIEWER,
            simulated_outcomes=simulated_outcomes(),
            evaluated_at=EVAL_AT,
        )
        return plane, candidate

    def test_approval_is_default_deny(self):
        plane, candidate = self._evaluated()
        with self.assertRaises(ApprovalDeniedError):
            plane.approve(
                candidate.candidate_id, candidate.version, None, REVIEWER
            )
        self.assertEqual(
            plane.status(candidate.candidate_id, candidate.version), STATUS_EVALUATED
        )

    def test_candidate_cannot_approve_itself(self):
        plane, candidate = self._evaluated()
        approval = ApprovalRecord(
            candidate_id=candidate.candidate_id,
            candidate_version=candidate.version,
            decision="approved",
            approved_by=AUTHOR,
            decided_at=DECIDED_AT,
            reason="self approval",
            role="candidate",
        )
        with self.assertRaises(ApprovalDeniedError):
            plane.approve(
                candidate.candidate_id,
                candidate.version,
                approval,
                Actor(AUTHOR, "candidate"),
            )

    def test_approval_record_must_match_actor_and_candidate(self):
        plane, candidate = self._evaluated()
        mismatched = ApprovalRecord(
            candidate_id=candidate.candidate_id,
            candidate_version=candidate.version,
            decision="approved",
            approved_by="someone.else",
            decided_at=DECIDED_AT,
            reason="forged approver",
            role="reviewer",
        )
        with self.assertRaises(ApprovalDeniedError):
            plane.approve(
                candidate.candidate_id, candidate.version, mismatched, REVIEWER
            )

    def test_explicit_approval_records_approver_time_and_reason(self):
        plane, candidate = self._evaluated()
        approve(plane, candidate)
        record = plane.record(candidate.candidate_id, candidate.version)
        self.assertEqual(record.status, STATUS_APPROVED)
        assert record.approval is not None
        self.assertEqual(record.approval.approved_by, REVIEWER.actor_id)
        self.assertEqual(record.approval.decided_at, DECIDED_AT)
        self.assertTrue(record.approval.reason)
        self.assertTrue(plane.audit.entries(action=ACTION_APPROVAL_RECORDED))

    def test_explicit_rejection_sets_rejected_status(self):
        plane, candidate = self._evaluated()
        rejection = ApprovalRecord(
            candidate_id=candidate.candidate_id,
            candidate_version=candidate.version,
            decision="rejected",
            approved_by=REVIEWER.actor_id,
            decided_at=DECIDED_AT,
            reason="insufficient evidence for a canary",
            role=REVIEWER.role,
        )
        plane.approve(candidate.candidate_id, candidate.version, rejection, REVIEWER)
        self.assertEqual(
            plane.status(candidate.candidate_id, candidate.version), STATUS_REJECTED
        )

    def test_approval_requires_a_passing_evaluation(self):
        plane = make_plane()
        candidate = plane.propose(make_candidate(), REVIEWER).candidate
        with self.assertRaises(LifecycleError):
            approve(plane, candidate)
        self.assertEqual(
            plane.status(candidate.candidate_id, candidate.version), STATUS_PROPOSED
        )


class CanaryTests(unittest.TestCase):
    def _approved(self) -> tuple[EvolutionControlPlane, Candidate]:
        plane = make_plane()
        candidate = plane.propose(make_candidate(), REVIEWER).candidate
        plane.evaluate(
            candidate.candidate_id,
            candidate.version,
            actor=REVIEWER,
            simulated_outcomes=simulated_outcomes(),
            real_outcomes=real_outcomes(correct=True),
            evaluated_at=EVAL_AT,
        )
        approve(plane, candidate)
        return plane, candidate

    def test_canary_requires_explicit_approval(self):
        plane = make_plane()
        candidate = plane.propose(make_candidate(), REVIEWER).candidate
        plane.evaluate(
            candidate.candidate_id,
            candidate.version,
            actor=REVIEWER,
            simulated_outcomes=simulated_outcomes(),
            evaluated_at=EVAL_AT,
        )
        with self.assertRaises(CanaryDeniedError):
            plane.start_canary(
                candidate.candidate_id, candidate.version, fraction=0.1, actor=REVIEWER
            )

    def test_canary_fraction_bounds_and_synthetic_only(self):
        plane, candidate = self._approved()
        for fraction in (0.0, -0.1, 1.5):
            with self.assertRaises(CanaryDeniedError):
                plane.start_canary(
                    candidate.candidate_id,
                    candidate.version,
                    fraction=fraction,
                    actor=REVIEWER,
                )
        state = plane.start_canary(
            candidate.candidate_id, candidate.version, fraction=0.1, actor=REVIEWER
        )
        self.assertTrue(state.synthetic_only)
        self.assertEqual(state.fraction, 0.1)
        self.assertEqual(
            plane.status(candidate.candidate_id, candidate.version), STATUS_CANARY
        )
        self.assertTrue(plane.audit.entries(action=ACTION_CANARY_STARTED))

    def test_candidate_cannot_start_a_canary(self):
        plane, candidate = self._approved()
        with self.assertRaises(CanaryDeniedError):
            plane.start_canary(
                candidate.candidate_id,
                candidate.version,
                fraction=0.1,
                actor=Actor(AUTHOR, "candidate"),
            )

    def test_circuit_breaker_trips_and_rolls_back(self):
        plane, candidate = self._approved()
        plane.start_canary(
            candidate.candidate_id, candidate.version, fraction=0.2, actor=REVIEWER
        )
        result = plane.observe_canary(
            candidate.candidate_id,
            candidate.version,
            CanaryObservation(
                regression=0.4,
                error_rate=0.5,
                sample_count=10,
                observed_at=EVAL_AT,
            ),
            REVIEWER,
        )
        self.assertTrue(result.tripped)
        self.assertIsNotNone(result.rollback)
        assert result.rollback is not None
        self.assertEqual(result.rollback.to_version, "pol-27")
        self.assertEqual(result.rollback.triggered_by, "circuit_breaker")
        self.assertEqual(
            plane.status(candidate.candidate_id, candidate.version),
            STATUS_ROLLED_BACK,
        )
        self.assertEqual(plane.stable_version(candidate.candidate_id), "pol-27")
        self.assertTrue(plane.audit.entries(action=ACTION_CANARY_CIRCUIT_BREAKER))
        self.assertTrue(plane.audit.entries(action=ACTION_ROLLBACK_COMPLETED))

    def test_healthy_canary_observations_do_not_trip(self):
        plane, candidate = self._approved()
        plane.start_canary(
            candidate.candidate_id,
            candidate.version,
            fraction=0.2,
            actor=REVIEWER,
            conditions=CanaryConditions(
                max_regression=0.1, max_error_rate=0.1, min_samples=5
            ),
        )
        result = plane.observe_canary(
            candidate.candidate_id,
            candidate.version,
            CanaryObservation(
                regression=0.01,
                error_rate=0.02,
                sample_count=10,
                observed_at=EVAL_AT,
            ),
            REVIEWER,
        )
        self.assertFalse(result.tripped)
        self.assertIsNone(result.rollback)
        self.assertEqual(
            plane.status(candidate.candidate_id, candidate.version), STATUS_CANARY
        )


class PromoteAndRollbackTests(unittest.TestCase):
    def test_promotion_requires_real_transfer_evidence(self):
        plane = make_plane()
        candidate = plane.propose(make_candidate(), REVIEWER).candidate
        plane.evaluate(
            candidate.candidate_id,
            candidate.version,
            actor=REVIEWER,
            simulated_outcomes=simulated_outcomes(),
            evaluated_at=EVAL_AT,
        )
        approve(plane, candidate)
        plane.start_canary(
            candidate.candidate_id, candidate.version, fraction=0.1, actor=REVIEWER
        )
        with self.assertRaises(EvolutionError):
            plane.promote(candidate.candidate_id, candidate.version, actor=REVIEWER)

    def test_promotion_after_real_evidence_updates_stable_version(self):
        plane = make_plane()
        candidate = plane.propose(make_candidate(), REVIEWER).candidate
        plane.evaluate(
            candidate.candidate_id,
            candidate.version,
            actor=REVIEWER,
            simulated_outcomes=simulated_outcomes(),
            real_outcomes=real_outcomes(correct=True),
            evaluated_at=EVAL_AT,
        )
        approve(plane, candidate)
        plane.start_canary(
            candidate.candidate_id, candidate.version, fraction=0.1, actor=REVIEWER
        )
        record = plane.promote(candidate.candidate_id, candidate.version, actor=REVIEWER)
        self.assertEqual(record.status, STATUS_PROMOTED)
        self.assertEqual(plane.stable_version(candidate.candidate_id), candidate.version)
        self.assertEqual(record.previous_stable_version, "pol-27")
        self.assertTrue(plane.audit.entries(action=ACTION_CANDIDATE_PROMOTED))

    def test_rollback_restores_previous_stable_version_and_records_event(self):
        plane = make_plane()
        candidate = plane.propose(make_candidate(), REVIEWER).candidate
        plane.evaluate(
            candidate.candidate_id,
            candidate.version,
            actor=REVIEWER,
            simulated_outcomes=simulated_outcomes(),
            real_outcomes=real_outcomes(correct=True),
            evaluated_at=EVAL_AT,
        )
        approve(plane, candidate)
        plane.start_canary(
            candidate.candidate_id, candidate.version, fraction=0.1, actor=REVIEWER
        )
        plane.promote(candidate.candidate_id, candidate.version, actor=REVIEWER)

        event = plane.rollback(
            candidate.candidate_id,
            candidate.version,
            actor=REVIEWER,
            reason="real canary regression observed",
        )
        self.assertEqual(event.from_version, candidate.version)
        self.assertEqual(event.to_version, "pol-27")
        self.assertEqual(plane.stable_version(candidate.candidate_id), "pol-27")
        record = plane.record(candidate.candidate_id, candidate.version)
        self.assertEqual(record.status, STATUS_ROLLED_BACK)
        assert record.rollback is not None
        self.assertEqual(record.rollback.reason, "real canary regression observed")
        self.assertTrue(plane.audit.entries(action=ACTION_ROLLBACK_COMPLETED))

    def test_candidate_cannot_roll_back_the_production_system(self):
        plane = make_plane()
        candidate = plane.propose(make_candidate(), REVIEWER).candidate
        plane.evaluate(
            candidate.candidate_id,
            candidate.version,
            actor=REVIEWER,
            simulated_outcomes=simulated_outcomes(),
            real_outcomes=real_outcomes(correct=True),
            evaluated_at=EVAL_AT,
        )
        approve(plane, candidate)
        plane.start_canary(
            candidate.candidate_id, candidate.version, fraction=0.1, actor=REVIEWER
        )
        with self.assertRaises(RollbackDeniedError):
            plane.rollback(
                candidate.candidate_id,
                candidate.version,
                actor=Actor(AUTHOR, "candidate"),
                reason="self rollback",
            )
        self.assertEqual(
            plane.status(candidate.candidate_id, candidate.version), STATUS_CANARY
        )

    def test_rollback_requires_a_canary_or_promotion(self):
        plane = make_plane()
        candidate = plane.propose(make_candidate(), REVIEWER).candidate
        with self.assertRaises(LifecycleError):
            plane.rollback(
                candidate.candidate_id,
                candidate.version,
                actor=REVIEWER,
                reason="nothing running",
            )


class AuditTests(unittest.TestCase):
    def test_audit_is_append_only_and_ordered(self):
        audit = AuditLog(now=lambda: EVAL_AT)
        first = audit.append(
            actor="host", action="candidate.registered", subject="c", outcome="accepted"
        )
        second = audit.append(
            actor="host", action="candidate.evaluated", subject="c", outcome="accepted"
        )
        self.assertEqual((first.seq, second.seq), (1, 2))
        self.assertEqual(len(audit.entries()), 2)
        self.assertFalse(hasattr(audit, "delete"))
        self.assertFalse(hasattr(audit, "update"))

    def test_audit_rejects_raw_student_data_keys(self):
        audit = AuditLog(now=lambda: EVAL_AT)
        for key in ("answer", "payload", "student_name", "trace"):
            with self.assertRaises(AuditError):
                audit.append(
                    actor="host",
                    action="candidate.registered",
                    subject="c",
                    outcome="accepted",
                    detail={key: "synthetic raw"},
                )

    def test_full_pipeline_is_audited_without_raw_data(self):
        plane = make_plane()
        candidate = plane.propose(make_candidate(), REVIEWER).candidate
        plane.evaluate(
            candidate.candidate_id,
            candidate.version,
            actor=REVIEWER,
            simulated_outcomes=simulated_outcomes(),
            real_outcomes=real_outcomes(correct=True),
            evaluated_at=EVAL_AT,
        )
        approve(plane, candidate)
        plane.start_canary(
            candidate.candidate_id, candidate.version, fraction=0.1, actor=REVIEWER
        )
        plane.rollback(
            candidate.candidate_id,
            candidate.version,
            actor=REVIEWER,
            reason="synthetic rollback drill",
        )
        actions = {entry.action for entry in plane.audit.entries()}
        self.assertIn(ACTION_CANDIDATE_REGISTERED, actions)
        self.assertIn(ACTION_CANDIDATE_EVALUATED, actions)
        self.assertIn(ACTION_APPROVAL_RECORDED, actions)
        self.assertIn(ACTION_CANARY_STARTED, actions)
        self.assertIn(ACTION_ROLLBACK_COMPLETED, actions)
        for entry in plane.audit.as_list():
            self.assertNotIn("answer", json_keys(entry))
            self.assertNotIn("payload", json_keys(entry))

    def test_pipeline_snapshot_declares_synthetic_isolation(self):
        plane = make_plane()
        plane.propose(make_candidate(), REVIEWER)
        snapshot = plane.pipeline_snapshot()
        self.assertFalse(snapshot["production_mutation_enabled"])
        self.assertFalse(snapshot["sandbox_has_production_access"])
        self.assertTrue(snapshot["synthetic_fixtures_only"])
        self.assertEqual(len(snapshot["candidates"]), 1)


def json_keys(value) -> set[str]:
    keys: set[str] = set()
    if isinstance(value, dict):
        for key, item in value.items():
            keys.add(key)
            keys |= json_keys(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            keys |= json_keys(item)
    return keys


if __name__ == "__main__":
    unittest.main()
