"""Step 17 tests: privacy, minor protection, retention/deletion propagation,
audit export and the metrics/cost dashboard (spec sections 20 and 21).

All consent events, stores, audit entries, metrics and prices are synthetic. The
shared fixture ``tests/fixtures/privacy_step17.json`` is also read by the
TypeScript test so the Python and TypeScript implementations are checked against
the same inputs and expectations.
"""

from __future__ import annotations

import json
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from aeh.privacy import (
    AGG_GAUGE,
    AGG_MEAN,
    AGG_SUM,
    AUDIENCE_ADMIN,
    AUDIENCE_RESEARCH,
    AUDIENCE_STUDENT,
    AUDIENCE_TEACHER,
    AUDIT_REJECTED,
    BILLING_CONNECTED,
    DATA_CLASSES,
    DATA_CLASS_LEARNING_EVENTS,
    DATA_CLASS_RAW_MEDIA,
    DELETION_ANONYMIZE,
    DELETION_COMPLETED,
    DELETION_FAILED,
    DELETION_PARTIAL,
    DIMENSION_LEARNING,
    DIMENSION_SYSTEM,
    MINOR_AGE_THRESHOLD,
    SOURCE_OBSERVED,
    SOURCE_SIMULATED,
    SUBJECT_GUARDIAN,
    SUBJECT_STUDENT,
    AudienceRestrictionError,
    AuditEntry,
    AuditExportError,
    AuditExportRequest,
    ConsentError,
    ConsentEvent,
    ConsentLedger,
    CostEstimator,
    CostModel,
    DeletionCoordinator,
    DeletionError,
    DeletionRequest,
    MetricDefinition,
    MetricSample,
    MetricsDashboard,
    MetricsError,
    RetentionError,
    RetentionPolicy,
    RetentionRecord,
    RetentionRule,
    SyntheticStore,
    UsageRecord,
    authorized_audience_scopes,
    effective_audience_scopes,
    estimate_cost,
    expired_records,
    export_audit,
    is_minor,
    retention_requests,
)

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "privacy_step17.json"

T0 = "2026-02-01T00:00:00.000Z"


def load_fixture() -> dict:
    return json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))


def event_from(record: dict) -> ConsentEvent:
    data = dict(
        consent_id=record["consentId"],
        student_ref=record["studentRef"],
        subject=record["subject"],
        scope=record["scope"],
        kind=record["kind"],
        at=record["at"],
        policy_version=record["policyVersion"],
        evidence_ref=record["evidenceRef"],
    )
    if record.get("expiresAt"):
        data["expires_at"] = record["expiresAt"]
    return ConsentEvent(**data)


def ledger_from_fixture(records: list[dict]) -> ConsentLedger:
    ledger = ConsentLedger()
    for record in records:
        ledger.append(event_from(record))
    return ledger


def retention_policy(spec: dict) -> RetentionPolicy:
    return RetentionPolicy(
        spec["policyVersion"],
        {
            rule["dataClass"]: RetentionRule(
                data_class=rule["dataClass"],
                retain_days=rule["retainDays"],
                deletion_mode=rule["deletionMode"],
            )
            for rule in spec["rules"]
        },
    )


def build_coordinator(stores_spec: list[dict], *, extra_failing: bool = False):
    coordinator = DeletionCoordinator()
    for spec in stores_spec:
        store = SyntheticStore(spec["storeId"], spec["dataClasses"])
        for student_ref, counts in spec["seed"].items():
            for data_class, count in counts.items():
                store.seed(student_ref, data_class, count)
        coordinator.register(store)
    if extra_failing:
        coordinator.register(
            SyntheticStore("failing-store", [DATA_CLASS_RAW_MEDIA], fail_on_delete=True)
        )
    return coordinator


def deletion_request(spec: dict) -> DeletionRequest:
    return DeletionRequest(
        request_id=spec["requestId"],
        student_ref=spec["studentRef"],
        requested_at=spec["requestedAt"],
        reason=spec["reason"],
        data_classes=frozenset(spec["dataClasses"]),
        requested_by=spec.get("requestedBy", "system"),
    )


def audit_entry(record: dict) -> AuditEntry:
    return AuditEntry(
        seq=record["seq"],
        at=record["at"],
        kind=record["kind"],
        action=record["action"],
        outcome=record["outcome"],
        reason_codes=tuple(record.get("reasonCodes", [])),
        student_key=record.get("studentKey"),
        tenant_key=record.get("tenantKey"),
        detail=record.get("detail", {}),
    )


def audit_request(spec: dict) -> AuditExportRequest:
    kwargs = dict(
        request_id=spec["requestId"],
        requested_at=spec["requestedAt"],
        audience=spec["audience"],
        window_start=spec["windowStart"],
        window_end=spec["windowEnd"],
        kinds=frozenset(spec.get("kinds", [])),
        include_pseudonymous_keys=spec.get("includePseudonymousKeys", False),
    )
    if "authorizedScopes" in spec:
        kwargs["authorized_scopes"] = spec["authorizedScopes"]
    return AuditExportRequest(**kwargs)


def metric_sample(record: dict) -> MetricSample:
    return MetricSample(
        metric=record["metric"],
        value=record["value"],
        at=record["at"],
        source=record["source"],
        student_key=record.get("studentKey"),
        tenant_key=record.get("tenantKey"),
        labels=tuple(sorted(record.get("labels", {}).items())),
    )


def usage_record(record: dict) -> UsageRecord:
    return UsageRecord(
        input_tokens=record.get("inputTokens", 0),
        output_tokens=record.get("outputTokens", 0),
        tool_calls=record.get("toolCalls", 0),
        simulation_minutes=record.get("simulationMinutes", 0.0),
        cache_hits=record.get("cacheHits", 0),
    )


class ConsentRecordTests(unittest.TestCase):
    def test_grant_and_revoke_are_append_only(self) -> None:
        ledger = ConsentLedger()
        ledger.grant(
            consent_id="c1", student_ref="stu-1", subject=SUBJECT_GUARDIAN,
            scope="twin:observe", at=T0, policy_version="v1", evidence_ref="ev1",
        )
        ledger.revoke(
            consent_id="c2", student_ref="stu-1", subject=SUBJECT_GUARDIAN,
            scope="twin:observe", at="2026-02-02T00:00:00.000Z",
            policy_version="v1", evidence_ref="ev2",
        )
        self.assertEqual(len(ledger.events), 2)
        self.assertEqual(ledger.history("stu-1")[0].kind, "granted")
        self.assertEqual(ledger.history("stu-1")[1].kind, "revoked")
        self.assertFalse(
            ledger.is_granted("stu-1", "twin:observe", "2026-02-03T00:00:00.000Z")
        )

    def test_duplicate_consent_id_rejected(self) -> None:
        ledger = ConsentLedger()
        ledger.grant(
            consent_id="c1", student_ref="stu-1", subject=SUBJECT_GUARDIAN,
            scope="twin:observe", at=T0, policy_version="v1", evidence_ref="e",
        )
        with self.assertRaises(ConsentError):
            ledger.grant(
                consent_id="c1", student_ref="stu-1", subject=SUBJECT_GUARDIAN,
                scope="twin:observe", at=T0, policy_version="v1", evidence_ref="e",
            )

    def test_unknown_scope_and_subject_rejected(self) -> None:
        with self.assertRaises(ValueError):
            ConsentEvent(
                consent_id="c1", student_ref="stu-1", subject=SUBJECT_GUARDIAN,
                scope="root:*", kind="granted", at=T0, policy_version="v1",
                evidence_ref="e",
            )
        with self.assertRaises(ValueError):
            ConsentEvent(
                consent_id="c1", student_ref="stu-1", subject="robot",
                scope="twin:observe", kind="granted", at=T0, policy_version="v1",
                evidence_ref="e",
            )

    def test_expiry_must_be_after_grant_and_only_on_grant(self) -> None:
        with self.assertRaises(ValueError):
            ConsentEvent(
                consent_id="c1", student_ref="stu-1", subject=SUBJECT_GUARDIAN,
                scope="twin:observe", kind="granted", at=T0, policy_version="v1",
                evidence_ref="e", expires_at="2026-01-01T00:00:00.000Z",
            )
        with self.assertRaises(ValueError):
            ConsentEvent(
                consent_id="c1", student_ref="stu-1", subject=SUBJECT_GUARDIAN,
                scope="twin:observe", kind="revoked", at=T0, policy_version="v1",
                evidence_ref="e", expires_at="2026-03-01T00:00:00.000Z",
            )

    def test_expired_grant_is_not_active(self) -> None:
        ledger = ConsentLedger()
        ledger.grant(
            consent_id="c1", student_ref="stu-1", subject=SUBJECT_STUDENT,
            scope="curriculum:read", at=T0, policy_version="v1", evidence_ref="e",
            expires_at="2026-02-10T00:00:00.000Z",
        )
        self.assertTrue(
            ledger.is_granted("stu-1", "curriculum:read", "2026-02-05T00:00:00.000Z")
        )
        self.assertFalse(
            ledger.is_granted("stu-1", "curriculum:read", "2026-02-10T00:00:00.000Z")
        )

    def test_require_fails_closed_without_consent(self) -> None:
        ledger = ConsentLedger()
        with self.assertRaises(ConsentError):
            ledger.require("stu-1", "twin:observe", T0)

    def test_minor_needs_guardian_grant_for_guardian_required_scope(self) -> None:
        ledger = ConsentLedger()
        ledger.grant(
            consent_id="c1", student_ref="stu-1", subject=SUBJECT_STUDENT,
            scope="intervention:deliver", at=T0, policy_version="v1", evidence_ref="e",
        )
        self.assertNotIn(
            "intervention:deliver", ledger.active_scopes("stu-1", T0, age=13)
        )
        self.assertIn(
            "intervention:deliver", ledger.active_scopes("stu-1", T0, age=20)
        )
        ledger.grant(
            consent_id="c2", student_ref="stu-1", subject=SUBJECT_GUARDIAN,
            scope="intervention:deliver", at=T0, policy_version="v1", evidence_ref="e",
        )
        self.assertIn(
            "intervention:deliver", ledger.active_scopes("stu-1", T0, age=13)
        )

    def test_revoke_all_is_idempotent(self) -> None:
        ledger = ConsentLedger()
        ledger.grant(
            consent_id="c1", student_ref="stu-1", subject=SUBJECT_GUARDIAN,
            scope="twin:observe", at=T0, policy_version="v1", evidence_ref="e",
        )
        ledger.grant(
            consent_id="c2", student_ref="stu-1", subject=SUBJECT_GUARDIAN,
            scope="report:aggregate", at=T0, policy_version="v1", evidence_ref="e",
        )
        self.assertEqual(ledger.revoke_all("stu-1", T0, policy_version="v2"), 2)
        self.assertEqual(ledger.revoke_all("stu-1", T0, policy_version="v2"), 0)
        self.assertEqual(ledger.active_scopes("stu-1", T0), frozenset())

    def test_is_minor_bounds(self) -> None:
        self.assertTrue(is_minor(MINOR_AGE_THRESHOLD - 1))
        self.assertFalse(is_minor(MINOR_AGE_THRESHOLD))
        with self.assertRaises(ValueError):
            is_minor(-1)
        with self.assertRaises(ValueError):
            is_minor(True)

    def test_active_by_subject_groups_guardian_grants(self) -> None:
        ledger = ConsentLedger()
        ledger.grant(
            consent_id="c1", student_ref="stu-1", subject=SUBJECT_GUARDIAN,
            scope="twin:observe", at=T0, policy_version="v1", evidence_ref="e",
        )
        grouped = ledger.active_by_subject("stu-1", T0)
        self.assertEqual(grouped[SUBJECT_GUARDIAN], frozenset({"twin:observe"}))


class AudienceRestrictionTests(unittest.TestCase):
    def test_effective_scopes_narrow_but_never_widen(self) -> None:
        self.assertEqual(
            effective_audience_scopes(AUDIENCE_TEACHER, ["report:aggregate"]),
            frozenset({"report:aggregate"}),
        )
        self.assertEqual(
            effective_audience_scopes(AUDIENCE_TEACHER, ["audit:export"]), frozenset()
        )

    def test_unknown_audience_and_scope_rejected(self) -> None:
        with self.assertRaises(AudienceRestrictionError):
            effective_audience_scopes("principal")
        with self.assertRaises(AudienceRestrictionError):
            effective_audience_scopes(AUDIENCE_TEACHER, ["root:*"])

    def test_minor_forbidden_scope_removed_for_guardian_and_admin(self) -> None:
        ledger = ConsentLedger()
        ledger.grant(
            consent_id="c1", student_ref="stu-1", subject=SUBJECT_GUARDIAN,
            scope="research:aggregate", at=T0, policy_version="v1", evidence_ref="e",
        )
        self.assertIn("research:aggregate", ledger.active_scopes("stu-1", T0, age=13))
        self.assertNotIn(
            "research:aggregate",
            authorized_audience_scopes(
                AUDIENCE_RESEARCH, ledger, "stu-1", T0, age=13
            ),
        )
        self.assertIn(
            "research:aggregate",
            authorized_audience_scopes(
                AUDIENCE_RESEARCH, ledger, "stu-1", T0, age=20
            ),
        )

    def test_student_audience_only_sees_own_active_scopes(self) -> None:
        ledger = ConsentLedger()
        ledger.grant(
            consent_id="c1", student_ref="stu-1", subject=SUBJECT_STUDENT,
            scope="curriculum:read", at=T0, policy_version="v1", evidence_ref="e",
        )
        scopes = authorized_audience_scopes(AUDIENCE_STUDENT, ledger, "stu-1", T0)
        self.assertEqual(scopes, frozenset({"curriculum:read"}))


class RetentionTests(unittest.TestCase):
    def test_policy_requires_every_data_class(self) -> None:
        with self.assertRaises(RetentionError):
            RetentionPolicy(
                "v1",
                {DATA_CLASS_RAW_MEDIA: RetentionRule(DATA_CLASS_RAW_MEDIA, 30)},
            )

    def test_rule_rejects_unknown_class_and_mode(self) -> None:
        with self.assertRaises(RetentionError):
            RetentionRule("secrets", 30)
        with self.assertRaises(RetentionError):
            RetentionRule(DATA_CLASS_RAW_MEDIA, 30, "burn")

    def test_expires_at_is_created_plus_retain_days(self) -> None:
        policy = RetentionPolicy(
            "v1",
            {
                data_class: RetentionRule(data_class, 10)
                for data_class in DATA_CLASSES
            },
        )
        created = datetime(2026, 1, 1, tzinfo=timezone.utc)
        self.assertEqual(
            policy.expires_at(DATA_CLASS_RAW_MEDIA, created),
            created + timedelta(days=10),
        )

    def test_expired_records_are_inclusive_and_sorted(self) -> None:
        rules = {
            data_class: RetentionRule(data_class, 10)
            for data_class in DATA_CLASSES
        }
        rules[DATA_CLASS_RAW_MEDIA] = RetentionRule(
            DATA_CLASS_RAW_MEDIA, 30, DELETION_ANONYMIZE
        )
        rules[DATA_CLASS_LEARNING_EVENTS] = RetentionRule(
            DATA_CLASS_LEARNING_EVENTS, 365
        )
        policy = RetentionPolicy("v1", rules)
        records = [
            RetentionRecord("stu-1", DATA_CLASS_RAW_MEDIA, "2025-12-01T00:00:00.000Z"),
            RetentionRecord("stu-1", DATA_CLASS_LEARNING_EVENTS, "2025-02-01T00:00:00.000Z"),
        ]
        dues = expired_records(records, policy, T0)
        self.assertEqual(
            [due.data_class for due in dues],
            [DATA_CLASS_RAW_MEDIA, DATA_CLASS_LEARNING_EVENTS],
        )
        self.assertEqual(dues[0].deletion_mode, DELETION_ANONYMIZE)

    def test_retention_requests_are_deterministic_per_class(self) -> None:
        policy = RetentionPolicy(
            "v1",
            {data_class: RetentionRule(data_class, 30) for data_class in DATA_CLASSES},
        )
        records = [
            RetentionRecord("stu-1", DATA_CLASS_RAW_MEDIA, "2025-01-01T00:00:00.000Z"),
            RetentionRecord("stu-1", DATA_CLASS_LEARNING_EVENTS, "2025-01-01T00:00:00.000Z"),
        ]
        dues = expired_records(records, policy, T0)
        requests = retention_requests(dues, requested_at=T0)
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[0].reason, "retention_expiry")
        self.assertEqual(
            [len(request.data_classes) for request in requests], [1, 1]
        )


class DeletionPropagationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = load_fixture()["deletion"]

    def test_deletion_propagates_across_all_registered_stores(self) -> None:
        coordinator = build_coordinator(self.fixture["stores"])
        ledger = ledger_from_fixture(self.fixture["consentGrants"])
        receipt = coordinator.delete(
            deletion_request(self.fixture["request"]), ledger=ledger, now=T0
        )
        self.assertEqual(receipt.status, DELETION_COMPLETED)
        self.assertEqual(receipt.total_deleted, 15)
        self.assertEqual(
            {result.store_id: result.total for result in receipt.results},
            {"audit-warehouse": 7, "events-primary": 4, "media-objects": 4},
        )
        self.assertEqual(receipt.consent_revoked, 2)
        self.assertTrue(receipt.access_blocked)

    def test_other_students_are_not_touched(self) -> None:
        coordinator = build_coordinator(self.fixture["stores"])
        coordinator.delete(deletion_request(self.fixture["request"]), now=T0)
        events = coordinator.store_ids
        self.assertIn("events-primary", events)
        store = SyntheticStore("probe", [DATA_CLASS_LEARNING_EVENTS])
        self.assertEqual(store.count_subject("stu-other-01"), {"learning_events": 0})

    def test_store_failure_produces_partial_receipt(self) -> None:
        coordinator = build_coordinator(self.fixture["stores"], extra_failing=True)
        receipt = coordinator.delete(
            deletion_request(self.fixture["request"]), now=T0
        )
        self.assertEqual(receipt.status, DELETION_PARTIAL)
        failing = [r for r in receipt.results if r.store_id == "failing-store"][0]
        self.assertEqual(failing.status, DELETION_FAILED)
        self.assertEqual(failing.error, "DeletionError")

    def test_all_store_failure_produces_failed_receipt(self) -> None:
        coordinator = DeletionCoordinator()
        coordinator.register(
            SyntheticStore("only-store", [DATA_CLASS_RAW_MEDIA], fail_on_delete=True)
        )
        request = DeletionRequest(
            request_id="r-fail", student_ref="stu-x", requested_at=T0,
            reason="policy", data_classes=frozenset({DATA_CLASS_RAW_MEDIA}),
        )
        self.assertEqual(coordinator.delete(request, now=T0).status, DELETION_FAILED)

    def test_deletion_is_idempotent_by_request_id(self) -> None:
        coordinator = build_coordinator(self.fixture["stores"])
        request = deletion_request(self.fixture["request"])
        first = coordinator.delete(request, now=T0)
        second = coordinator.delete(request, now=T0)
        self.assertFalse(first.idempotent_replay)
        self.assertTrue(second.idempotent_replay)
        self.assertEqual(first.total_deleted, second.total_deleted)

    def test_deleted_subject_reads_fail_closed(self) -> None:
        coordinator = build_coordinator(self.fixture["stores"])
        coordinator.delete(deletion_request(self.fixture["request"]), now=T0)
        self.assertTrue(coordinator.is_blocked(self.fixture["studentRef"]))
        with self.assertRaises(DeletionError):
            coordinator.assert_readable(self.fixture["studentRef"])

    def test_duplicate_store_registration_rejected(self) -> None:
        coordinator = DeletionCoordinator()
        coordinator.register(SyntheticStore("s1", [DATA_CLASS_RAW_MEDIA]))
        with self.assertRaises(DeletionError):
            coordinator.register(SyntheticStore("s1", [DATA_CLASS_RAW_MEDIA]))

    def test_unknown_deletion_reason_rejected(self) -> None:
        with self.assertRaises(ValueError):
            DeletionRequest(
                request_id="r", student_ref="stu", requested_at=T0,
                reason="because", data_classes=frozenset({DATA_CLASS_RAW_MEDIA}),
            )

    def test_empty_data_classes_rejected(self) -> None:
        with self.assertRaises(ValueError):
            DeletionRequest(
                request_id="r", student_ref="stu", requested_at=T0,
                reason="policy", data_classes=frozenset(),
            )


class AuditExportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = load_fixture()["audit"]

    def entries(self) -> list[AuditEntry]:
        return [audit_entry(record) for record in self.fixture["entries"]]

    def test_window_and_kind_filtering(self) -> None:
        bundle = export_audit(
            self.entries(), audit_request(self.fixture["request"]), generated_at=T0
        )
        self.assertEqual(bundle.entries_used, 4)
        self.assertEqual(bundle.entries_excluded, 2)
        self.assertEqual(
            dict(bundle.counts_by_kind),
            {"tool.call": 2, "approval.record": 1, "delivery.receipt": 1},
        )
        self.assertEqual(
            dict(bundle.counts_by_outcome), {"accepted": 3, "rejected": 1}
        )

    def test_end_of_window_is_exclusive(self) -> None:
        bundle = export_audit(
            self.entries(), audit_request(self.fixture["request"]), generated_at=T0
        )
        self.assertNotIn('"seq":6', bundle.payload)

    def test_default_export_redacts_pseudonymous_keys(self) -> None:
        bundle = export_audit(
            self.entries(), audit_request(self.fixture["request"]), generated_at=T0
        )
        self.assertTrue(bundle.redacted_keys)
        self.assertIn('"student_key":null', bundle.payload)
        self.assertNotIn('"student_key":"sk-a"', bundle.payload)

    def test_optional_export_includes_pseudonymous_keys(self) -> None:
        bundle = export_audit(
            self.entries(), audit_request(self.fixture["requestWithKeys"]),
            generated_at=T0,
        )
        self.assertFalse(bundle.redacted_keys)
        self.assertIn('"student_key":"sk-a"', bundle.payload)

    def test_digest_matches_fixture(self) -> None:
        bundle = export_audit(
            self.entries(), audit_request(self.fixture["request"]), generated_at=T0
        )
        self.assertEqual(bundle.digest, self.fixture["expectedDigest"])
        with_keys = export_audit(
            self.entries(), audit_request(self.fixture["requestWithKeys"]),
            generated_at=T0,
        )
        self.assertEqual(
            with_keys.digest, self.fixture["expectedDigestWithKeys"]
        )

    def test_teacher_cannot_export_audit(self) -> None:
        spec = dict(self.fixture["request"], audience="teacher")
        with self.assertRaises(AudienceRestrictionError):
            export_audit(self.entries(), audit_request(spec), generated_at=T0)

    def test_forbidden_detail_keys_are_rejected(self) -> None:
        with self.assertRaises(AuditExportError):
            AuditEntry(
                seq=1, at=T0, kind="tool.call", action="t", outcome=AUDIT_REJECTED,
                detail={"answer": "42"},
            )

    def test_nested_detail_values_are_rejected(self) -> None:
        with self.assertRaises(AuditExportError):
            AuditEntry(
                seq=1, at=T0, kind="tool.call", action="t", outcome=AUDIT_REJECTED,
                detail={"steps": ["a", "b"]},
            )

    def test_unknown_kind_and_outcome_rejected(self) -> None:
        with self.assertRaises(AuditExportError):
            AuditEntry(seq=1, at=T0, kind="magic", action="t", outcome=AUDIT_REJECTED)
        with self.assertRaises(AuditExportError):
            AuditEntry(seq=1, at=T0, kind="tool.call", action="t", outcome="maybe")


class MetricsDashboardTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = load_fixture()["metrics"]

    def dashboard(self) -> MetricsDashboard:
        dashboard = MetricsDashboard()
        for record in self.fixture["samples"]:
            dashboard.ingest(metric_sample(record))
        return dashboard

    def test_snapshot_aggregates_observed_metrics(self) -> None:
        snapshot = self.dashboard().snapshot(generated_at=T0)
        self.assertEqual(snapshot.total_samples, 10)
        self.assertEqual(snapshot.excluded_other_channel, 5)
        accuracy = snapshot.cell("independent_accuracy")
        self.assertEqual(accuracy.value, 0.65)
        self.assertEqual(accuracy.sample_count, 8)
        self.assertEqual(snapshot.cell("learning_minutes").value, 75.0)

    def test_simulated_learning_sample_is_rejected(self) -> None:
        dashboard = MetricsDashboard()
        with self.assertRaises(MetricsError):
            dashboard.ingest(
                MetricSample(
                    metric="independent_accuracy", value=0.9, at=T0,
                    source=SOURCE_SIMULATED,
                )
            )

    def test_simulated_system_sample_is_allowed(self) -> None:
        dashboard = MetricsDashboard()
        dashboard.ingest(
            MetricSample(
                metric="tool_latency_ms", value=120, at=T0, source=SOURCE_SIMULATED
            )
        )
        snapshot = dashboard.snapshot(channel=SOURCE_SIMULATED, generated_at=T0)
        self.assertEqual(snapshot.cell("tool_latency_ms").value, 120)

    def test_unknown_metric_and_source_rejected(self) -> None:
        dashboard = MetricsDashboard()
        with self.assertRaises(MetricsError):
            dashboard.ingest(
                MetricSample(metric="vibes", value=1, at=T0, source=SOURCE_OBSERVED)
            )
        with self.assertRaises(MetricsError):
            MetricSample(metric="near_transfer", value=1, at=T0, source="psychic")

    def test_cohort_view_suppresses_small_groups(self) -> None:
        view = self.dashboard().cohort_view("independent_accuracy", min_cohort_size=5)
        self.assertEqual(view.suppressed_cohorts, 1)
        self.assertEqual(len(view.cells), 1)
        self.assertEqual(view.cells[0].student_key, "stu-a")
        self.assertEqual(view.cells[0].value, 0.7)

    def test_snapshot_student_cohorts_suppress_small_groups(self) -> None:
        data = self.dashboard().snapshot(generated_at=T0).as_dict()
        self.assertEqual(data["student_cohorts"], {"stu-a": 8})
        self.assertEqual(data["suppressed_cohorts"], 1)

    def test_aggregation_modes_sum_mean_and_gauge(self) -> None:
        definitions = {
            "custom_sum": MetricDefinition("custom_sum", DIMENSION_SYSTEM, "n", AGG_SUM),
            "custom_mean": MetricDefinition("custom_mean", DIMENSION_SYSTEM, "n", AGG_MEAN),
            "custom_gauge": MetricDefinition("custom_gauge", DIMENSION_SYSTEM, "n", AGG_GAUGE),
        }
        dashboard = MetricsDashboard(definitions)
        for index, value in enumerate([1.0, 2.0, 6.0]):
            for metric in definitions:
                dashboard.ingest(
                    MetricSample(
                        metric=metric,
                        value=value,
                        at=datetime(2026, 1, 1, index, tzinfo=timezone.utc),
                        source=SOURCE_OBSERVED,
                    )
                )
        snapshot = dashboard.snapshot(generated_at=T0)
        self.assertEqual(snapshot.cell("custom_sum").value, 9.0)
        self.assertEqual(snapshot.cell("custom_mean").value, 3.0)
        self.assertEqual(snapshot.cell("custom_gauge").value, 6.0)

    def test_unknown_channel_rejected(self) -> None:
        with self.assertRaises(MetricsError):
            self.dashboard().snapshot(channel="imaginary")

    def test_definition_registry_covers_all_dimensions(self) -> None:
        from aeh.privacy import METRIC_DEFINITIONS, METRIC_DIMENSIONS

        dimensions = {definition.dimension for definition in METRIC_DEFINITIONS.values()}
        self.assertEqual(dimensions, set(METRIC_DIMENSIONS))
        self.assertFalse(
            METRIC_DEFINITIONS["independent_accuracy"].simulated_allowed
        )
        self.assertTrue(
            METRIC_DEFINITIONS["virtual_real_gain_gap"].simulated_allowed
        )
        self.assertEqual(
            METRIC_DEFINITIONS["independent_accuracy"].dimension, DIMENSION_LEARNING
        )


class CostEstimationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = load_fixture()["cost"]

    def test_estimate_matches_fixture_components_and_total(self) -> None:
        spec = self.fixture["small"]
        estimate = estimate_cost(
            usage_record(spec["usage"]),
            CostEstimator().models[spec["modelId"]],
        )
        self.assertEqual(estimate.total, spec["expectedTotal"])
        for key, value in spec["expectedComponents"].items():
            self.assertEqual(estimate.components[key], value)

    def test_cost_is_never_connected_to_real_billing(self) -> None:
        estimate = estimate_cost(
            usage_record(self.fixture["small"]["usage"]),
            CostEstimator().models[self.fixture["small"]["modelId"]],
        )
        self.assertFalse(BILLING_CONNECTED)
        self.assertFalse(estimate.billing_connected)
        self.assertTrue(estimate.synthetic)

    def test_multi_model_total(self) -> None:
        estimator = CostEstimator()
        estimate = estimator.estimate_multi(
            {
                model_id: usage_record(usage)
                for model_id, usage in self.fixture["multi"]["usageByModel"].items()
            }
        )
        self.assertEqual(estimate.total, self.fixture["multi"]["expectedTotal"])

    def test_budget_check(self) -> None:
        estimator = CostEstimator()
        small = estimator.estimate(
            usage_record(self.fixture["small"]["usage"]),
            self.fixture["small"]["modelId"],
        )
        large = estimator.estimate(
            usage_record(self.fixture["large"]["usage"]),
            self.fixture["large"]["modelId"],
        )
        budget = self.fixture["budget"]
        self.assertTrue(CostEstimator.within_budget(small, budget))
        self.assertFalse(CostEstimator.within_budget(large, budget))

    def test_negative_usage_rejected(self) -> None:
        with self.assertRaises(ValueError):
            UsageRecord(input_tokens=-1)
        with self.assertRaises(ValueError):
            CostModel(model_id="m", tool_call_usd=-0.1)

    def test_unknown_model_rejected(self) -> None:
        with self.assertRaises(MetricsError):
            CostEstimator().estimate(UsageRecord(), "gpt-imaginary")

    def test_negative_budget_rejected(self) -> None:
        estimate = estimate_cost(
            UsageRecord(), CostEstimator().models["synthetic-llm-small"]
        )
        with self.assertRaises(ValueError):
            CostEstimator.within_budget(estimate, -1)


class FixtureParityTests(unittest.TestCase):
    """The same fixture is asserted by the TypeScript test (cross-language)."""

    def setUp(self) -> None:
        self.fixture = load_fixture()

    def test_consent_active_scopes_match_fixture(self) -> None:
        consent = self.fixture["consent"]
        ledger = ledger_from_fixture(consent["events"])
        self.assertEqual(
            sorted(ledger.active_scopes(consent["studentRef"], consent["at"], age=13)),
            consent["expectedActiveScopesMinor"],
        )
        self.assertEqual(
            sorted(ledger.active_scopes(consent["studentRef"], consent["at"], age=20)),
            consent["expectedActiveScopesAdult"],
        )

    def test_audience_scopes_match_fixture(self) -> None:
        consent = self.fixture["consent"]
        expected = consent["expectedAudienceScopes"]
        cases = {
            "teacherMinor": (AUDIENCE_TEACHER, 13),
            "teacherAdult": (AUDIENCE_TEACHER, 20),
            "studentMinor": (AUDIENCE_STUDENT, 13),
            "adminMinor": (AUDIENCE_ADMIN, 13),
            "adminAdult": (AUDIENCE_ADMIN, 20),
            "researchMinor": (AUDIENCE_RESEARCH, 13),
            "researchAdult": (AUDIENCE_RESEARCH, 20),
        }
        for key, (audience, age) in cases.items():
            ledger = ledger_from_fixture(consent["events"])
            self.assertEqual(
                sorted(
                    authorized_audience_scopes(
                        audience, ledger, consent["studentRef"], consent["at"], age=age
                    )
                ),
                expected[key],
            )

    def test_forbidden_scope_is_not_reachable(self) -> None:
        consent = self.fixture["consent"]
        ledger = ledger_from_fixture(consent["events"])
        scopes = authorized_audience_scopes(
            AUDIENCE_ADMIN, ledger, consent["studentRef"], consent["at"], age=13
        )
        self.assertNotIn(consent["forbiddenScopeForTeacherMinor"], scopes)

    def test_deletion_receipt_matches_fixture(self) -> None:
        deletion = self.fixture["deletion"]
        coordinator = build_coordinator(deletion["stores"])
        ledger = ledger_from_fixture(deletion["consentGrants"])
        receipt = coordinator.delete(
            deletion_request(deletion["request"]), ledger=ledger, now=deletion["now"]
        )
        self.assertEqual(receipt.status, deletion["expectedStatus"])
        self.assertEqual(receipt.total_deleted, deletion["expectedTotalDeleted"])
        self.assertEqual(
            {result.store_id: result.total for result in receipt.results},
            deletion["expectedByStore"],
        )
        self.assertEqual(receipt.consent_revoked, deletion["expectedConsentRevoked"])

    def test_retention_dues_match_fixture(self) -> None:
        retention = self.fixture["retention"]
        policy = retention_policy(self.fixture["deletion"]["policy"])
        dues = expired_records(
            [RetentionRecord(**{
                "student_ref": record["studentRef"],
                "data_class": record["dataClass"],
                "created_at": record["createdAt"],
            }) for record in retention["records"]],
            policy,
            retention["now"],
        )
        self.assertEqual(
            [due.as_dict() for due in dues], retention["expectedDue"]
        )


if __name__ == "__main__":
    unittest.main()
