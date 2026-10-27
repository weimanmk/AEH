"""Step 16 tests: service boundaries, storage implementations, write
coordination and the Harness state machine (spec sections 12 and 13).

All events, profiles, bundles, content, evaluation items and state scripts are
synthetic.  The shared fixture ``tests/fixtures/services_step16.json`` is also
read by the TypeScript test so the Python and TypeScript implementations are
checked against the same inputs and expectations.
"""

from __future__ import annotations

import json
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from pathlib import Path

from aeh.evaluation import (
    EvalItem,
    FrozenEvalSet,
    RealOutcome,
    SelfProofError,
    SimulatedOutcome,
    SplitIsolationError,
)
from aeh.services import (
    BRANCH_ABNORMAL_PRESSURE,
    BRANCH_CONTENT_REJECTED,
    BRANCH_CURRICULUM_GATE_REJECTED,
    BRANCH_HYPOTHESES_ALL_MISMATCHED,
    BRANCH_LOW_CONFIDENCE_STRATEGY,
    BRANCH_OCR_UNCERTAIN,
    BRANCH_RAG_SOURCE_MISSING,
    BRANCH_SCHOOL_PROGRESS_UNCLEAR,
    BRANCH_SIMULATION_TIMEOUT,
    BRANCH_SPARSE_MEMORY_DATA,
    BRANCH_STUDENT_REFUSES_DIAGNOSIS,
    BRANCH_SYMBOL_VERIFIER_UNCERTAIN,
    CONTENT_APPROVED,
    CONTENT_DRAFT,
    DEFAULT_MAX_REJECTIONS,
    DOMAIN_OBSERVED,
    DOMAIN_SIMULATED,
    EVENT_INDEPENDENT_ATTEMPT,
    EVENT_REVIEW_COMPLETED,
    EVENT_SIMULATION_STARTED,
    EVENT_TYPES,
    EXCEPTION_BRANCHES,
    STATE_ABORTED,
    STATE_ASSESS,
    STATE_AWAIT_STUDENT,
    STATE_CANDIDATE_RANKING,
    STATE_COMPLETED,
    STATE_CONTENT_VALIDATION,
    STATE_CURRICULUM_GATE,
    STATE_DELIVER,
    STATE_DIAGNOSE,
    STATE_EVIDENCE_PARSE,
    STATE_EXERCISE_EVOLUTION,
    STATE_FAILED,
    STATE_HYPOTHESIS_UPDATE,
    STATE_INTAKE,
    STATE_NEED_CLARIFICATION,
    STATE_PROBE,
    STATE_PROGRESS_CHECK,
    STATE_RECALL_SCHEDULE,
    STATE_PREVIEW_PLANNER,
    STATE_REVIEW_RESCHEDULE,
    STATE_SIMULATION_LAB,
    STATE_STATE_COMMIT,
    STATE_STATE_LOAD,
    SOURCE_OBSERVED,
    SOURCE_SIMULATED,
    TRANSITIONS,
    AppendResult,
    BundleStore,
    ConflictError,
    ContentLibraryService,
    ContentRecord,
    EvaluationRun,
    EvaluationService,
    EventDraft,
    EventStore,
    FileBundleStore,
    FileContentLibrary,
    FileEvaluationService,
    FileEventStore,
    FileProfileStore,
    HarnessStateMachine,
    IdempotencyConflictError,
    InMemoryBundleStore,
    InMemoryContentLibrary,
    InMemoryEvaluationService,
    InMemoryEventStore,
    InMemoryProfileStore,
    IntegrityError,
    InvalidTransitionError,
    IsolationViolationError,
    NotFoundError,
    OptimisticConcurrencyError,
    ProfileBundle,
    ProfileStore,
    ServiceError,
    StateMachineError,
    StudentProfile,
    ValidationError,
    WriteCoordinator,
    canonical_json,
    content_digest,
    exception_branch,
    utcnow,
)

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "services_step16.json"


def load_fixture() -> dict:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def to_dt(value) -> datetime:
    if isinstance(value, datetime):
        return value
    return datetime.fromisoformat(value)


def draft_from(record: dict, stream_id: str) -> EventDraft:
    return EventDraft(
        stream_id=stream_id,
        event_type=record["eventType"],
        source_type=record["sourceType"],
        occurred_at=record["occurredAt"],
        idempotency_key=record["idempotencyKey"],
        session_id=record.get("sessionId", ""),
        payload=record.get("payload", {}),
    )


def run_script(machine: HarnessStateMachine, script: list[str]) -> None:
    """Drive the machine; the gate rework edge uses register_rejection."""

    for target in script:
        if (
            machine.state == STATE_CURRICULUM_GATE
            and target == STATE_EXERCISE_EVOLUTION
        ):
            machine.register_rejection(
                code=BRANCH_CURRICULUM_GATE_REJECTED, reason="fixture_rework"
            )
        else:
            machine.advance(target, reason="fixture")


def machine_at(steps: list[str]) -> HarnessStateMachine:
    machine = HarnessStateMachine("student.demo.1")
    for step in steps:
        machine.advance(step, reason="setup")
    return machine


class SharedFixtureTests(unittest.TestCase):
    """Python and TypeScript must agree on the shared synthetic fixture."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.fixture = load_fixture()

    def test_fixture_is_synthetic(self) -> None:
        self.assertTrue(self.fixture["meta"]["synthetic"])

    def test_event_store_fixture(self) -> None:
        block = self.fixture["eventStore"]
        store = InMemoryEventStore(block["domain"])
        results = []
        for record in block["appends"]:
            results.append(
                store.append(
                    draft_from(record, block["streamId"]),
                    expected_version=record["expectedVersion"],
                )
            )
        self.assertEqual(
            [result.deduplicated for result in results],
            block["expectedDeduplicated"],
        )
        self.assertEqual(
            [result.event.sequence for result in results],
            block["expectedSequences"],
        )
        self.assertEqual(store.stream_version(block["streamId"]), block["expectedVersion"])

    def test_profile_fixture(self) -> None:
        block = self.fixture["profile"]
        store: ProfileStore = InMemoryProfileStore()
        profile = store.create(
            StudentProfile(
                student_ref=block["studentRef"],
                stage=block["stage"],
                guardian_consent=block["guardianConsent"],
                settings=block["settings"],
            )
        )
        self.assertEqual(profile.version, block["expectedCreateVersion"])
        updated = store.update(
            block["studentRef"],
            expected_version=block["expectedCreateVersion"],
            settings=block["patch"],
        )
        self.assertEqual(updated.version, block["expectedUpdatedVersion"])
        self.assertEqual(
            updated.settings["preferred_session_minutes"],
            block["patch"]["preferred_session_minutes"],
        )

    def test_bundle_fixture_is_content_addressed(self) -> None:
        block = self.fixture["bundle"]
        store: BundleStore = InMemoryBundleStore()
        bundle = ProfileBundle(
            student_ref=block["studentRef"],
            twin_version=block["twinVersion"],
            school_progress_version=block["schoolProgressVersion"],
            content_version=block["contentVersion"],
            created_at=block["createdAt"],
        )
        stored = store.put(bundle)
        self.assertEqual(stored.digest, bundle.digest)
        self.assertEqual(store.put(bundle).digest, bundle.digest)

    def test_content_fixture(self) -> None:
        block = self.fixture["content"]
        library: ContentLibraryService = InMemoryContentLibrary()
        for record in block["records"]:
            library.put(
                record["contentId"],
                kc_ids=record["kcIds"],
                difficulty=record["difficulty"],
                review_state=record["reviewState"],
                expected_version=0,
            )
        hits = library.retrieve(block["retrieveKc"])
        self.assertEqual(
            [record.content_id for record in hits], block["retrieveExpectedIds"]
        )

    def test_evaluation_fixture(self) -> None:
        block = self.fixture["evaluation"]
        service: EvaluationService = InMemoryEvaluationService()
        frozen = FrozenEvalSet(
            dataset_id=block["datasetId"],
            version=block["version"],
            frozen_at=to_dt(block["frozenAt"]),
            items=tuple(
                EvalItem(
                    item_id=item["itemId"],
                    kc_id=item["kcId"],
                    split=item["split"],
                    difficulty=item.get("difficulty", 2),
                    seen_before=item.get("seenBefore", False),
                )
                for item in block["items"]
            ),
        )
        service.register_dataset(frozen)
        run = service.run(
            block["datasetId"],
            idempotency_key=block["idempotencyKey"],
            simulated_outcomes=tuple(
                SimulatedOutcome(item["itemId"], item["predictedCorrect"])
                for item in block["simulated"]
            ),
            real_outcomes=tuple(
                RealOutcome(
                    item_id=item["itemId"],
                    correct=item["correct"],
                    source=item["source"],
                    occurred_at=to_dt(item["occurredAt"]),
                    independent=item.get("independent", True),
                )
                for item in block["real"]
            ),
        )
        self.assertAlmostEqual(
            run.simulated["mean_predicted_correct"],
            block["expectedSimulatedMean"],
        )
        self.assertAlmostEqual(
            run.simulated["simulated_gain"], block["expectedSimulatedGain"]
        )
        self.assertAlmostEqual(
            run.real_transfer["transfer_accuracy"], block["expectedRealAccuracy"]
        )
        self.assertEqual(
            run.real_transfer["sources"], block["expectedRealSources"]
        )
        self.assertIn(block["expectedClaimContains"], run.claim)

    def test_state_machine_fixture(self) -> None:
        block = self.fixture["stateMachine"]
        machine = HarnessStateMachine(block["studentRef"])
        run_script(machine, block["script"])
        self.assertEqual(machine.state, block["expectedFinalState"])
        self.assertEqual(len(machine.history), block["expectedTransitions"])
        self.assertEqual(machine.rejections, 0)

    def test_probe_and_rework_script_fixture(self) -> None:
        block = self.fixture["stateMachine"]
        machine = HarnessStateMachine(block["studentRef"])
        run_script(machine, block["probeScript"])
        self.assertEqual(machine.state, block["expectedProbeFinalState"])
        self.assertEqual(machine.rejections, block["expectedProbeRejections"])

    def test_exception_branch_targets_fixture(self) -> None:
        for code, target in self.fixture["stateMachine"]["exceptions"].items():
            self.assertEqual(exception_branch(code).target_state, target)

    def test_write_coordinator_fixture(self) -> None:
        block = self.fixture["writeCoordinator"]
        coordinator = WriteCoordinator()
        calls: list[int] = []

        def operation() -> int:
            calls.append(1)
            return len(calls)

        first, dedup_a = coordinator.run_once(
            block["streamId"], block["idempotencyKey"], operation
        )
        second, dedup_b = coordinator.run_once(
            block["streamId"], block["idempotencyKey"], operation
        )
        self.assertEqual(first, second)
        self.assertFalse(dedup_a)
        self.assertTrue(dedup_b)
        self.assertEqual(len(calls), block["expectedRunOnce"])


class EventStoreTests(unittest.TestCase):
    def make_draft(self, **overrides) -> EventDraft:
        base = dict(
            stream_id="student.a",
            event_type=EVENT_INDEPENDENT_ATTEMPT,
            source_type=SOURCE_OBSERVED,
            occurred_at="2026-10-26T20:15:00+08:00",
            idempotency_key="k1",
            payload={"item_id": "item_1"},
        )
        base.update(overrides)
        return EventDraft(**base)

    def test_append_assigns_sequence_and_version(self) -> None:
        store = InMemoryEventStore(DOMAIN_OBSERVED)
        result = store.append(self.make_draft())
        self.assertEqual(result.event.sequence, 1)
        self.assertEqual(result.stream_version, 1)
        self.assertFalse(result.deduplicated)

    def test_idempotent_replay_returns_same_event(self) -> None:
        store = InMemoryEventStore(DOMAIN_OBSERVED)
        first = store.append(self.make_draft())
        second = store.append(self.make_draft())
        self.assertTrue(second.deduplicated)
        self.assertEqual(first.event.event_id, second.event.event_id)
        self.assertEqual(store.stream_version("student.a"), 1)

    def test_idempotency_conflict_on_different_payload(self) -> None:
        store = InMemoryEventStore(DOMAIN_OBSERVED)
        store.append(self.make_draft())
        with self.assertRaises(IdempotencyConflictError):
            store.append(self.make_draft(payload={"item_id": "item_2"}))

    def test_optimistic_concurrency_conflict(self) -> None:
        store = InMemoryEventStore(DOMAIN_OBSERVED)
        store.append(self.make_draft(), expected_version=0)
        with self.assertRaises(OptimisticConcurrencyError):
            store.append(self.make_draft(idempotency_key="k2"), expected_version=0)

    def test_optimistic_concurrency_allows_matching_version(self) -> None:
        store = InMemoryEventStore(DOMAIN_OBSERVED)
        store.append(self.make_draft(), expected_version=0)
        result = store.append(self.make_draft(idempotency_key="k2"), expected_version=1)
        self.assertEqual(result.event.sequence, 2)

    def test_get_list_and_lookup(self) -> None:
        store = InMemoryEventStore(DOMAIN_OBSERVED)
        result = store.append(self.make_draft())
        self.assertEqual(store.get(result.event.event_id), result.event)
        self.assertEqual(
            store.find_by_idempotency("student.a", "k1"), result.event
        )
        self.assertIsNone(store.find_by_idempotency("student.a", "missing"))
        self.assertEqual(len(store.list_events("student.a", limit=1)), 1)
        with self.assertRaises(NotFoundError):
            store.get("ev_missing")

    def test_observed_store_rejects_simulated_source(self) -> None:
        store = InMemoryEventStore(DOMAIN_OBSERVED)
        with self.assertRaises(IsolationViolationError):
            store.append(self.make_draft(source_type=SOURCE_SIMULATED))

    def test_observed_store_rejects_simulation_event_type(self) -> None:
        store = InMemoryEventStore(DOMAIN_OBSERVED)
        with self.assertRaises(IsolationViolationError):
            store.append(
                self.make_draft(event_type=EVENT_SIMULATION_STARTED)
            )

    def test_simulated_store_rejects_observed_source(self) -> None:
        store = InMemoryEventStore(DOMAIN_SIMULATED)
        with self.assertRaises(IsolationViolationError):
            store.append(self.make_draft())
        result = store.append(
            self.make_draft(source_type=SOURCE_SIMULATED, event_type=EVENT_SIMULATION_STARTED)
        )
        self.assertEqual(result.event.source_type, SOURCE_SIMULATED)

    def test_unknown_event_and_source_are_rejected(self) -> None:
        with self.assertRaises(ValidationError):
            self.make_draft(event_type="NOT_AN_EVENT")
        with self.assertRaises(ValidationError):
            self.make_draft(source_type="guess")

    def test_payload_must_be_small_scalars(self) -> None:
        with self.assertRaises(ValidationError):
            self.make_draft(payload={"nested": {"a": 1}})
        with self.assertRaises(ValidationError):
            self.make_draft(payload={"blob": "x" * 5000})

    def test_schema_version_is_pinned(self) -> None:
        with self.assertRaises(ValidationError):
            self.make_draft(schema_version="aeh.event.v0")

    def test_concurrent_idempotent_appends_are_single_flight(self) -> None:
        store = InMemoryEventStore(DOMAIN_OBSERVED)
        barrier = threading.Barrier(8)
        results: list[AppendResult] = []
        guard = threading.Lock()

        def worker() -> None:
            barrier.wait()
            result = store.append(self.make_draft())
            with guard:
                results.append(result)

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(store.stream_version("student.a"), 1)
        self.assertEqual(len(results), 8)
        self.assertEqual(sum(1 for item in results if not item.deduplicated), 1)

    def test_file_event_store_persists_and_reloads(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            store = FileEventStore(root, DOMAIN_OBSERVED)
            result = store.append(self.make_draft())
            reopened = FileEventStore(root, DOMAIN_OBSERVED)
            self.assertEqual(reopened.stream_version("student.a"), 1)
            self.assertEqual(
                reopened.get(result.event.event_id).payload["item_id"], "item_1"
            )

    def test_file_event_store_detects_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            store = FileEventStore(root, DOMAIN_OBSERVED)
            store.append(self.make_draft())
            path = Path(root) / "events.observed.jsonl"
            record = json.loads(path.read_text(encoding="utf-8").strip())
            record["payload"]["item_id"] = "tampered"
            path.write_text(
                json.dumps(record, sort_keys=True) + "\n", encoding="utf-8"
            )
            with self.assertRaises(IntegrityError):
                FileEventStore(root, DOMAIN_OBSERVED)

    def test_file_event_store_rejects_foreign_domain_file(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "events.observed.jsonl"
            record = {
                "event_id": "ev_x",
                "stream_id": "s",
                "event_type": EVENT_INDEPENDENT_ATTEMPT,
                "source_type": SOURCE_SIMULATED,
                "occurred_at": "2026-10-26T20:15:00+08:00",
                "sequence": 1,
                "idempotency_key": "k",
                "session_id": "",
                "provenance": "synthetic",
                "payload": {},
                "schema_version": "aeh.event.v1",
            }
            record["digest"] = content_digest(record)
            path.write_text(json.dumps(record) + "\n", encoding="utf-8")
            with self.assertRaises(IntegrityError):
                FileEventStore(root, DOMAIN_OBSERVED)


class WriteCoordinatorTests(unittest.TestCase):
    def test_run_once_memoises(self) -> None:
        coordinator = WriteCoordinator()
        calls: list[int] = []
        value, dedup = coordinator.run_once("s", "k", lambda: calls.append(1) or 1)
        self.assertEqual(value, 1)
        self.assertFalse(dedup)
        value, dedup = coordinator.run_once("s", "k", lambda: calls.append(1) or 2)
        self.assertEqual(value, 1)
        self.assertTrue(dedup)
        self.assertEqual(calls, [1])

    def test_distinct_keys_run_independently(self) -> None:
        coordinator = WriteCoordinator()
        first, _ = coordinator.run_once("s", "k1", lambda: "a")
        second, _ = coordinator.run_once("s", "k2", lambda: "b")
        self.assertNotEqual(first, second)
        self.assertEqual(coordinator.stats()["memo"], 2)

    def test_run_once_is_single_flight_under_threads(self) -> None:
        coordinator = WriteCoordinator()
        barrier = threading.Barrier(8)
        calls: list[int] = []
        guard = threading.Lock()

        def operation() -> str:
            with guard:
                calls.append(1)
            return "value"

        results: list[tuple[str, bool]] = []
        result_guard = threading.Lock()

        def worker() -> None:
            barrier.wait()
            outcome = coordinator.run_once("stream", "key", operation)
            with result_guard:
                results.append(outcome)

        threads = [threading.Thread(target=worker) for _ in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(len(calls), 1)
        self.assertEqual(results, [("value", False)] + [("value", True)] * 7)


class ProfileAndBundleTests(unittest.TestCase):
    def test_profile_create_and_duplicate(self) -> None:
        store: ProfileStore = InMemoryProfileStore()
        store.create(StudentProfile(student_ref="student.a", stage="senior_secondary"))
        with self.assertRaises(ConflictError):
            store.create(StudentProfile(student_ref="student.a"))
        self.assertEqual(len(store.list_all()), 1)

    def test_profile_update_is_optimistic(self) -> None:
        store: ProfileStore = InMemoryProfileStore()
        store.create(StudentProfile(student_ref="student.a"))
        updated = store.update(
            "student.a", expected_version=1, guardian_consent=True
        )
        self.assertEqual(updated.version, 2)
        self.assertTrue(updated.guardian_consent)
        with self.assertRaises(OptimisticConcurrencyError):
            store.update("student.a", expected_version=1)

    def test_profile_missing_raises(self) -> None:
        store: ProfileStore = InMemoryProfileStore()
        with self.assertRaises(NotFoundError):
            store.get("student.missing")

    def test_profile_stage_validation(self) -> None:
        with self.assertRaises(ValidationError):
            StudentProfile(student_ref="student.a", stage="kindergarten")

    def test_file_profile_store_persists(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            store = FileProfileStore(root)
            store.create(
                StudentProfile(
                    student_ref="student.a",
                    stage="senior_secondary",
                    settings={"locale": "zh-CN"},
                )
            )
            reopened = FileProfileStore(root)
            self.assertEqual(
                reopened.get("student.a").settings["locale"], "zh-CN"
            )

    def test_bundle_store_is_idempotent_and_conflict_aware(self) -> None:
        store: BundleStore = InMemoryBundleStore()
        bundle = ProfileBundle(
            student_ref="student.a",
            twin_version=54,
            school_progress_version=15,
            content_version=7,
            created_at=utcnow(),
        )
        self.assertEqual(store.put(bundle).digest, bundle.digest)
        self.assertEqual(len(store.list_for_student("student.a")), 1)
        self.assertEqual(store.list_for_student("student.b"), ())

    def test_bundle_digest_binds_versions(self) -> None:
        first = ProfileBundle(
            student_ref="student.a",
            twin_version=54,
            school_progress_version=15,
            content_version=7,
            created_at="2026-10-27T09:00:00+08:00",
        )
        second = ProfileBundle(
            student_ref="student.a",
            twin_version=55,
            school_progress_version=15,
            content_version=7,
            created_at="2026-10-27T09:00:00+08:00",
        )
        self.assertNotEqual(first.digest, second.digest)

    def test_file_bundle_store_persists(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            store = FileBundleStore(root)
            bundle = ProfileBundle(
                student_ref="student.a",
                twin_version=1,
                school_progress_version=2,
                content_version=3,
                created_at="2026-10-27T09:00:00+08:00",
            )
            store.put(bundle)
            reopened = FileBundleStore(root)
            self.assertEqual(reopened.get(bundle.bundle_id).digest, bundle.digest)


class ContentLibraryTests(unittest.TestCase):
    def seed(self, library: ContentLibraryService) -> None:
        library.put(
            "item_1",
            kc_ids=("algebra.square_compensation",),
            difficulty=3,
            review_state=CONTENT_APPROVED,
            expected_version=0,
        )
        library.put(
            "item_2",
            kc_ids=("algebra.square_compensation",),
            difficulty=2,
            review_state=CONTENT_DRAFT,
            expected_version=0,
        )
        library.put(
            "item_3",
            kc_ids=("algebra.other",),
            difficulty=2,
            review_state=CONTENT_DRAFT,
            expected_version=0,
        )

    def test_retrieve_returns_only_approved(self) -> None:
        library = InMemoryContentLibrary()
        self.seed(library)
        hits = library.retrieve("algebra.square_compensation")
        self.assertEqual([hit.content_id for hit in hits], ["item_1"])

    def test_retrieve_is_fail_closed_without_approved(self) -> None:
        library = InMemoryContentLibrary()
        self.seed(library)
        self.assertEqual(library.retrieve("algebra.other"), ())

    def test_retrieve_filters_difficulty_and_is_sorted(self) -> None:
        library = InMemoryContentLibrary()
        library.put(
            "item_a",
            kc_ids=("kc.x",),
            difficulty=4,
            review_state=CONTENT_APPROVED,
            expected_version=0,
        )
        library.put(
            "item_b",
            kc_ids=("kc.x",),
            difficulty=1,
            review_state=CONTENT_APPROVED,
            expected_version=0,
        )
        hits = library.retrieve("kc.x")
        self.assertEqual([hit.content_id for hit in hits], ["item_b", "item_a"])
        self.assertEqual(
            [hit.content_id for hit in library.retrieve("kc.x", difficulty=4)],
            ["item_a"],
        )

    def test_version_bump_and_optimistic_concurrency(self) -> None:
        library = InMemoryContentLibrary()
        library.put(
            "item_1",
            kc_ids=("kc.x",),
            difficulty=2,
            review_state=CONTENT_DRAFT,
            expected_version=0,
        )
        updated = library.put(
            "item_1",
            kc_ids=("kc.x",),
            difficulty=2,
            review_state=CONTENT_APPROVED,
            expected_version=1,
        )
        self.assertEqual(updated.version, 2)
        self.assertEqual(library.current_version("item_1"), 2)
        with self.assertRaises(OptimisticConcurrencyError):
            library.put(
                "item_1",
                kc_ids=("kc.x",),
                difficulty=5,
                review_state=CONTENT_DRAFT,
                expected_version=1,
            )

    def test_identical_write_is_idempotent(self) -> None:
        library = InMemoryContentLibrary()
        first = library.put(
            "item_1",
            kc_ids=("kc.x",),
            difficulty=2,
            review_state=CONTENT_DRAFT,
            expected_version=0,
        )
        second = library.put(
            "item_1",
            kc_ids=("kc.x",),
            difficulty=2,
            review_state=CONTENT_DRAFT,
            expected_version=0,
        )
        self.assertEqual(first.version, second.version)

    def test_get_version_and_missing(self) -> None:
        library = InMemoryContentLibrary()
        self.seed(library)
        self.assertEqual(library.get("item_1").version, 1)
        with self.assertRaises(NotFoundError):
            library.get("item_missing")
        with self.assertRaises(NotFoundError):
            library.get("item_1", version=9)

    def test_content_record_validation(self) -> None:
        with self.assertRaises(ValidationError):
            ContentRecord(
                content_id="item_1",
                version=1,
                kc_ids=(),
                difficulty=2,
                review_state=CONTENT_DRAFT,
            )
        with self.assertRaises(ValidationError):
            ContentRecord(
                content_id="item_1",
                version=1,
                kc_ids=("kc.x",),
                difficulty=9,
                review_state=CONTENT_DRAFT,
            )

    def test_file_content_library_persists(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            library = FileContentLibrary(root)
            self.seed(library)
            reopened = FileContentLibrary(root)
            self.assertEqual(reopened.current_version("item_1"), 1)
            self.assertEqual(len(reopened.retrieve("algebra.square_compensation")), 1)


class EvaluationServiceTests(unittest.TestCase):
    def frozen_set(self, *, version: str = "v1") -> FrozenEvalSet:
        return FrozenEvalSet(
            dataset_id="eval_demo",
            version=version,
            frozen_at=to_dt("2026-10-27T00:00:00+00:00"),
            items=(
                EvalItem("train_1", "kc.x", "train"),
                EvalItem("explain_1", "kc.x", "explanation"),
                EvalItem("transfer_1", "kc.x", "transfer"),
            ),
        )

    def test_register_dataset_is_idempotent_and_conflict_aware(self) -> None:
        service: EvaluationService = InMemoryEvaluationService()
        summary = service.register_dataset(self.frozen_set())
        self.assertEqual(summary["dataset_id"], "eval_demo")
        self.assertEqual(
            service.register_dataset(self.frozen_set())["digest"], summary["digest"]
        )
        altered = FrozenEvalSet(
            dataset_id="eval_demo",
            version="v2",
            frozen_at=to_dt("2026-10-28T00:00:00+00:00"),
            items=(
                EvalItem("train_1", "kc.x", "train"),
                EvalItem("transfer_1", "kc.x", "transfer"),
            ),
        )
        with self.assertRaises(ConflictError):
            service.register_dataset(altered)

    def test_run_records_separated_channels_and_dedupes(self) -> None:
        service: EvaluationService = InMemoryEvaluationService()
        service.register_dataset(self.frozen_set())
        simulated = (SimulatedOutcome("train_1", 0.8),)
        real = (
            RealOutcome(
                "transfer_1", True, "trusted_grader", to_dt("2026-10-27T10:00:00+00:00")
            ),
        )
        first = service.run(
            "eval_demo",
            idempotency_key="run-1",
            simulated_outcomes=simulated,
            real_outcomes=real,
        )
        second = service.run(
            "eval_demo",
            idempotency_key="run-1",
            simulated_outcomes=simulated,
            real_outcomes=real,
        )
        self.assertEqual(first.run_id, second.run_id)
        self.assertAlmostEqual(first.simulated["mean_predicted_correct"], 0.8)
        self.assertAlmostEqual(first.real_transfer["transfer_accuracy"], 1.0)
        self.assertEqual(service.get_run(first.run_id).dataset_id, "eval_demo")

    def test_run_idempotency_conflict_on_different_inputs(self) -> None:
        service: EvaluationService = InMemoryEvaluationService()
        service.register_dataset(self.frozen_set())
        service.run(
            "eval_demo",
            idempotency_key="run-1",
            simulated_outcomes=(SimulatedOutcome("train_1", 0.8),),
        )
        with self.assertRaises(IdempotencyConflictError):
            service.run(
                "eval_demo",
                idempotency_key="run-1",
                simulated_outcomes=(SimulatedOutcome("train_1", 0.1),),
            )

    def test_simulated_outcome_cannot_touch_transfer(self) -> None:
        service: EvaluationService = InMemoryEvaluationService()
        service.register_dataset(self.frozen_set())
        with self.assertRaises(SplitIsolationError):
            service.run(
                "eval_demo",
                idempotency_key="run-bad",
                simulated_outcomes=(SimulatedOutcome("transfer_1", 0.9),),
            )

    def test_simulated_source_cannot_feed_real_channel(self) -> None:
        with self.assertRaises(SelfProofError):
            RealOutcome(
                "transfer_1", True, "simulated", to_dt("2026-10-27T10:00:00+00:00")
            )

    def test_absent_real_evidence_is_reported_as_absent(self) -> None:
        service: EvaluationService = InMemoryEvaluationService()
        service.register_dataset(self.frozen_set())
        run = service.run(
            "eval_demo",
            idempotency_key="run-sim-only",
            simulated_outcomes=(SimulatedOutcome("train_1", 0.9),),
        )
        self.assertIsNone(run.real_transfer)
        self.assertIn("no real transfer evidence", run.claim)

    def test_file_evaluation_service_persists(self) -> None:
        with tempfile.TemporaryDirectory() as root:
            service = FileEvaluationService(root)
            service.register_dataset(self.frozen_set())
            run = service.run(
                "eval_demo",
                idempotency_key="run-file",
                simulated_outcomes=(SimulatedOutcome("train_1", 0.6),),
            )
            reopened = FileEvaluationService(root)
            self.assertEqual(reopened.get_dataset("eval_demo").digest, self.frozen_set().digest)
            self.assertEqual(reopened.get_run(run.run_id).run_id, run.run_id)


class StateMachineTests(unittest.TestCase):
    def test_normal_transitions_match_spec(self) -> None:
        self.assertEqual(
            TRANSITIONS[STATE_PROGRESS_CHECK],
            frozenset({STATE_NEED_CLARIFICATION, STATE_STATE_LOAD}),
        )
        self.assertEqual(
            TRANSITIONS[STATE_STATE_LOAD],
            frozenset(
                {STATE_DIAGNOSE, STATE_RECALL_SCHEDULE, STATE_PREVIEW_PLANNER}
            ),
        )
        self.assertEqual(
            TRANSITIONS[STATE_CURRICULUM_GATE],
            frozenset({STATE_EXERCISE_EVOLUTION, STATE_CONTENT_VALIDATION}),
        )
        self.assertEqual(TRANSITIONS[STATE_COMPLETED], frozenset())

    def test_illegal_transition_is_rejected(self) -> None:
        machine = HarnessStateMachine("student.a")
        with self.assertRaises(InvalidTransitionError):
            machine.advance(STATE_DELIVER, reason="skip")
        self.assertEqual(machine.state, STATE_INTAKE)

    def test_terminal_state_is_fail_closed(self) -> None:
        machine = machine_at(
            [
                STATE_EVIDENCE_PARSE,
                STATE_PROGRESS_CHECK,
                STATE_STATE_LOAD,
                STATE_RECALL_SCHEDULE,
                STATE_EXERCISE_EVOLUTION,
                STATE_SIMULATION_LAB,
                STATE_CANDIDATE_RANKING,
                STATE_CURRICULUM_GATE,
                STATE_CONTENT_VALIDATION,
                STATE_DELIVER,
                STATE_AWAIT_STUDENT,
                STATE_ASSESS,
                STATE_STATE_COMMIT,
                STATE_REVIEW_RESCHEDULE,
                STATE_COMPLETED,
            ]
        )
        self.assertTrue(machine.is_terminal)
        self.assertEqual(machine.allowed_next(), frozenset())
        with self.assertRaises(StateMachineError):
            machine.advance(STATE_FAILED, reason="late")

    def test_idempotent_advance(self) -> None:
        machine = HarnessStateMachine("student.a")
        first = machine.advance(
            STATE_EVIDENCE_PARSE, reason="intake", idempotency_key="t1"
        )
        second = machine.advance(
            STATE_EVIDENCE_PARSE, reason="retry", idempotency_key="t1"
        )
        self.assertEqual(first, second)
        self.assertEqual(len(machine.history), 1)
        with self.assertRaises(IdempotencyConflictError):
            machine.advance(
                STATE_PROGRESS_CHECK, reason="retry", idempotency_key="t1"
            )

    def test_snapshot_has_no_student_content(self) -> None:
        machine = HarnessStateMachine("student.a", session_id="sess-1")
        machine.advance(STATE_EVIDENCE_PARSE, reason="intake")
        snapshot = machine.snapshot()
        self.assertEqual(snapshot["state"], STATE_EVIDENCE_PARSE)
        self.assertEqual(snapshot["transitions"][0]["reason"], "intake")
        self.assertNotIn("answer", json.dumps(snapshot))

    def test_rejection_bound_fails_closed(self) -> None:
        machine = HarnessStateMachine("student.a", max_rejections=3)
        for step in (
            STATE_EVIDENCE_PARSE,
            STATE_PROGRESS_CHECK,
            STATE_STATE_LOAD,
            STATE_RECALL_SCHEDULE,
            STATE_EXERCISE_EVOLUTION,
            STATE_SIMULATION_LAB,
            STATE_CANDIDATE_RANKING,
            STATE_CURRICULUM_GATE,
        ):
            machine.advance(step, reason="setup")
        for _ in range(3):
            machine.register_rejection(
                code=BRANCH_CURRICULUM_GATE_REJECTED, reason="rework"
            )
            machine.advance(STATE_SIMULATION_LAB, reason="rework")
            machine.advance(STATE_CANDIDATE_RANKING, reason="rework")
            machine.advance(STATE_CURRICULUM_GATE, reason="rework")
        record = machine.register_rejection(
            code=BRANCH_CURRICULUM_GATE_REJECTED, reason="rework"
        )
        self.assertEqual(machine.rejections, 4)
        self.assertEqual(machine.state, STATE_FAILED)
        self.assertEqual(record.to_state, STATE_FAILED)

    def test_default_rejection_bound(self) -> None:
        self.assertEqual(DEFAULT_MAX_REJECTIONS, 3)
        machine = HarnessStateMachine("student.a", max_rejections=1)
        machine.advance(STATE_EVIDENCE_PARSE, reason="setup")
        machine.advance(STATE_PROGRESS_CHECK, reason="setup")
        machine.advance(STATE_STATE_LOAD, reason="setup")
        machine.advance(STATE_RECALL_SCHEDULE, reason="setup")
        machine.advance(STATE_EXERCISE_EVOLUTION, reason="setup")
        machine.advance(STATE_SIMULATION_LAB, reason="setup")
        machine.advance(STATE_CANDIDATE_RANKING, reason="setup")
        machine.advance(STATE_CURRICULUM_GATE, reason="setup")
        machine.register_rejection()
        machine.advance(STATE_SIMULATION_LAB, reason="setup")
        machine.advance(STATE_CANDIDATE_RANKING, reason="setup")
        machine.advance(STATE_CURRICULUM_GATE, reason="setup")
        machine.register_rejection()
        self.assertEqual(machine.state, STATE_FAILED)

    def test_exception_branches_reroute(self) -> None:
        ocr = machine_at([STATE_EVIDENCE_PARSE])
        ocr.handle_exception(BRANCH_OCR_UNCERTAIN)
        self.assertEqual(ocr.state, STATE_NEED_CLARIFICATION)

        progress = machine_at([STATE_EVIDENCE_PARSE, STATE_PROGRESS_CHECK])
        progress.handle_exception(BRANCH_SCHOOL_PROGRESS_UNCLEAR)
        self.assertEqual(progress.state, STATE_NEED_CLARIFICATION)

        probe = machine_at(
            [STATE_EVIDENCE_PARSE, STATE_PROGRESS_CHECK, STATE_STATE_LOAD, STATE_DIAGNOSE, STATE_HYPOTHESIS_UPDATE]
        )
        probe.handle_exception(BRANCH_HYPOTHESES_ALL_MISMATCHED)
        self.assertEqual(probe.state, STATE_PROBE)

        lab = machine_at(
            [
                STATE_EVIDENCE_PARSE,
                STATE_PROGRESS_CHECK,
                STATE_STATE_LOAD,
                STATE_RECALL_SCHEDULE,
                STATE_EXERCISE_EVOLUTION,
                STATE_SIMULATION_LAB,
            ]
        )
        lab.handle_exception(BRANCH_SIMULATION_TIMEOUT)
        self.assertEqual(lab.state, STATE_CANDIDATE_RANKING)

        load = machine_at(
            [STATE_EVIDENCE_PARSE, STATE_PROGRESS_CHECK, STATE_STATE_LOAD]
        )
        load.handle_exception(BRANCH_SPARSE_MEMORY_DATA)
        self.assertEqual(load.state, STATE_RECALL_SCHEDULE)

        refusal = machine_at(
            [STATE_EVIDENCE_PARSE, STATE_PROGRESS_CHECK, STATE_STATE_LOAD, STATE_DIAGNOSE]
        )
        refusal.handle_exception(BRANCH_STUDENT_REFUSES_DIAGNOSIS)
        self.assertEqual(refusal.state, STATE_ABORTED)

    def test_degrade_in_place_branches_do_not_move(self) -> None:
        machine = machine_at([STATE_EVIDENCE_PARSE, STATE_PROGRESS_CHECK])
        for code in (
            BRANCH_RAG_SOURCE_MISSING,
            BRANCH_LOW_CONFIDENCE_STRATEGY,
            BRANCH_ABNORMAL_PRESSURE,
        ):
            branch = machine.handle_exception(code)
            self.assertEqual(branch.target_state, "")
            self.assertEqual(machine.state, STATE_PROGRESS_CHECK)
        self.assertEqual(len(machine.snapshot()["degraded"]), 3)

    def test_unknown_exception_branch_is_rejected(self) -> None:
        machine = HarnessStateMachine("student.a")
        with self.assertRaises(ValidationError):
            machine.handle_exception("not_a_branch")

    def test_every_exception_branch_has_a_description(self) -> None:
        for branch in EXCEPTION_BRANCHES.values():
            self.assertTrue(branch.degraded_mode)
            self.assertTrue(branch.description)
            self.assertIn(branch.target_state, {"", *TRANSITIONS.keys()})

    def test_all_spec_states_are_known(self) -> None:
        expected = {
            "Intake",
            "EvidenceParse",
            "ProgressCheck",
            "NeedClarification",
            "StateLoad",
            "Diagnose",
            "HypothesisUpdate",
            "Probe",
            "AwaitStudent",
            "ExerciseEvolution",
            "RecallSchedule",
            "PreviewPlanner",
            "SimulationLab",
            "CandidateRanking",
            "CurriculumGate",
            "ContentValidation",
            "Deliver",
            "Assess",
            "StateCommit",
            "ReviewReschedule",
            "Completed",
            "Failed",
            "Aborted",
        }
        self.assertEqual(set(TRANSITIONS), expected)
        self.assertTrue(expected.issuperset({STATE_INTAKE, STATE_FAILED, STATE_ABORTED}))

    def test_event_catalog_contains_section_22_events(self) -> None:
        self.assertIn(EVENT_INDEPENDENT_ATTEMPT, EVENT_TYPES)
        self.assertIn(EVENT_REVIEW_COMPLETED, EVENT_TYPES)
        self.assertIn(EVENT_SIMULATION_STARTED, EVENT_TYPES)
        self.assertEqual(len(EVENT_TYPES), 39)

    def test_service_error_hierarchy(self) -> None:
        self.assertTrue(issubclass(OptimisticConcurrencyError, ConflictError))
        self.assertTrue(issubclass(IdempotencyConflictError, ConflictError))
        self.assertTrue(issubclass(InvalidTransitionError, StateMachineError))
        self.assertTrue(issubclass(ServiceError, Exception))
        self.assertEqual(
            canonical_json({"b": 1, "a": 2}), '{"a":2,"b":1}'
        )


if __name__ == "__main__":
    unittest.main()
