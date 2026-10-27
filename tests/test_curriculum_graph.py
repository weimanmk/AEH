"""Step 9 tests: KC graph, versioned item bank, local RAG, gate-bound retrieval.

All data is synthetic and comes from either in-memory fixtures or the shared
JSON parity fixture.  No real student, item text, answer, hint, or solution is
used.
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from aeh.curriculum_gate import (
    MODE_LEARN,
    LearnerProgress,
    allow,
)
from aeh.curriculum_graph import (
    EDGE_STATUSES,
    GraphEdge,
    GraphNode,
    GraphValidationError,
    ItemAnnotation,
    ItemBank,
    ItemNotFoundError,
    ItemValidationError,
    KnowledgeGraph,
    KnowledgeGraphStore,
    QMatrixEntry,
    RetrievalQuery,
    ReviewTransitionError,
    UnknownKnowledgeComponent,
    content_hash,
    plan_retrieval,
    prerequisite_diagnostics,
)

FIXTURE = Path(__file__).parent / "fixtures" / "curriculum_step9.json"


def complete_annotation(**overrides):
    values = {
        "source": "synthetic.bank",
        "license": "synthetic-only",
        "stage": "secondary",
        "course": "synthetic.mathematics",
        "grade_level": 8,
        "curriculum_node_ids": ("kc.quadratic.formula",),
        "required_kcs": ("kc.quadratic.formula",),
        "q_matrix": (QMatrixEntry("kc.quadratic.formula", 0.95),),
        "difficulty": 0.5,
        "item_type": "short_answer",
        "estimated_minutes": 5.0,
        "verifier_type": "deterministic",
        "safety_checked": True,
        "content_verified": True,
        "correctness_verified": True,
        "annotation_confidence": 0.95,
        "cognitive_load": 0.2,
    }
    values.update(overrides)
    return ItemAnnotation(**values)


def make_progress(**overrides):
    values = {
        "student_id": "synthetic.student.step9",
        "grade_level": 8,
        "taught_kcs": frozenset(
            {
                "kc.quadratic.formula",
                "kc.algebra.square_root",
                "kc.arith.square_root",
                "kc.advanced.quadratic",
            }
        ),
        "progress_confidence": 0.95,
        "current_load": 0.0,
        "load_budget": 1.0,
    }
    values.update(overrides)
    return LearnerProgress(**values)


def make_graph():
    nodes = (
        GraphNode("kc.arith.square_root"),
        GraphNode("kc.algebra.square_root"),
        GraphNode("kc.quadratic.formula"),
        GraphNode("kc.advanced.quadratic"),
        GraphNode("kc.calculus.derivative"),
    )
    edges = (
        GraphEdge("kc.algebra.square_root", "kc.arith.square_root"),
        GraphEdge("kc.quadratic.formula", "kc.algebra.square_root"),
        GraphEdge("kc.calculus.derivative", "kc.quadratic.formula"),
        GraphEdge("kc.advanced.quadratic", "kc.calculus.derivative"),
    )
    return KnowledgeGraph(1, nodes, edges)


def approve(bank, item_id, annotation, *, submitted="2026-03-01T00:00:00Z"):
    bank.add_item(item_id, annotation)
    bank.submit_for_review(item_id, "reviewer.synthetic.1", submitted_at=submitted)
    bank.review(
        item_id,
        "approve",
        "reviewer.synthetic.1",
        reviewed_at="2026-03-01T00:00:01Z",
    )
    return bank.current(item_id)


def load_fixture():
    return json.loads(FIXTURE.read_text(encoding="utf-8"))


def graph_from_fixture(data):
    return KnowledgeGraph(
        data["graph"]["version"],
        data["graph"]["nodes"],
        data["graph"]["edges"],
    )


def bank_from_fixture(data):
    bank = ItemBank()
    for entry in data["items"]:
        approved = entry["reviewStatus"] == "approved"
        bank.add_item(
            entry["itemId"],
            entry["annotation"],
            review_status="draft" if approved else entry["reviewStatus"],
        )
        if approved:
            bank.submit_for_review(
                entry["itemId"],
                "reviewer.synthetic.1",
                submitted_at="2026-03-01T00:00:00Z",
            )
            bank.review(
                entry["itemId"],
                "approve",
                "reviewer.synthetic.1",
                reviewed_at="2026-03-01T00:00:01Z",
            )
    return bank


def progress_from_fixture(data):
    p = data["progress"]
    return LearnerProgress(
        student_id=p["studentId"],
        grade_level=p["gradeLevel"],
        taught_kcs=frozenset(p["taughtKcs"]),
        in_progress_kcs=frozenset(p["inProgressKcs"]),
        confirmed_preview_kcs=frozenset(p["confirmedPreviewKcs"]),
        confirmed_prior_kcs=frozenset(p["confirmedPriorKcs"]),
        progress_confidence=p["progressConfidence"],
        current_load=p["currentLoad"],
        load_budget=p["loadBudget"],
        extension_mode=p["extensionMode"],
    )


class KnowledgeGraphTests(unittest.TestCase):
    def test_prerequisite_closure_is_transitive_and_excludes_self(self):
        graph = make_graph()
        self.assertEqual(
            graph.prerequisite_closure("kc.advanced.quadratic"),
            frozenset(
                {
                    "kc.calculus.derivative",
                    "kc.quadratic.formula",
                    "kc.algebra.square_root",
                    "kc.arith.square_root",
                }
            ),
        )
        self.assertNotIn(
            "kc.advanced.quadratic",
            graph.prerequisite_closure("kc.advanced.quadratic"),
        )

    def test_direct_prerequisites_and_unknown_kc(self):
        graph = make_graph()
        self.assertEqual(
            graph.prerequisites_of("kc.quadratic.formula"),
            ("kc.algebra.square_root",),
        )
        with self.assertRaises(UnknownKnowledgeComponent):
            graph.prerequisite_closure("kc.not.in.graph")

    def test_topological_order_puts_prerequisites_first(self):
        order = make_graph().topological_order()
        self.assertLess(
            order.index("kc.arith.square_root"),
            order.index("kc.algebra.square_root"),
        )
        self.assertLess(
            order.index("kc.algebra.square_root"),
            order.index("kc.quadratic.formula"),
        )
        self.assertLess(
            order.index("kc.quadratic.formula"),
            order.index("kc.calculus.derivative"),
        )

    def test_cycle_is_rejected(self):
        with self.assertRaises(GraphValidationError):
            KnowledgeGraph(
                1,
                (GraphNode("kc.a"), GraphNode("kc.b")),
                (
                    GraphEdge("kc.a", "kc.b", relation="REQUIRES"),
                    GraphEdge("kc.b", "kc.a", relation="REQUIRES"),
                ),
            )

    def test_self_loop_and_unknown_endpoint_are_rejected(self):
        with self.assertRaises(GraphValidationError):
            KnowledgeGraph(
                1,
                (GraphNode("kc.a"),),
                (GraphEdge("kc.a", "kc.a"),),
            )
        with self.assertRaises(GraphValidationError):
            KnowledgeGraph(
                1,
                (GraphNode("kc.a"),),
                (GraphEdge("kc.a", "kc.missing"),),
            )

    def test_duplicate_nodes_edges_and_unknown_relation_are_rejected(self):
        with self.assertRaises(GraphValidationError):
            KnowledgeGraph(
                1, (GraphNode("kc.a"), GraphNode("kc.a"))
            )
        with self.assertRaises(GraphValidationError):
            KnowledgeGraph(
                1,
                (GraphNode("kc.a"), GraphNode("kc.b")),
                (GraphEdge("kc.a", "kc.b"), GraphEdge("kc.a", "kc.b")),
            )
        with self.assertRaises(GraphValidationError):
            KnowledgeGraph(
                1,
                (GraphNode("kc.a"), GraphNode("kc.b")),
                (GraphEdge("kc.a", "kc.b", relation="UNKNOWN"),),
            )

    def test_proposed_edges_are_not_authoritative_prerequisites(self):
        graph = KnowledgeGraph(
            1,
            (GraphNode("kc.a"), GraphNode("kc.b")),
            (
                GraphEdge(
                    "kc.a",
                    "kc.b",
                    relation="REQUIRES",
                    status="proposed",
                    confidence=0.4,
                ),
            ),
        )
        self.assertEqual(graph.prerequisite_closure("kc.a"), frozenset())
        self.assertFalse(graph.has_cycle())
        # A proposed edge may form a cycle without making the graph illegal;
        # only approved edges are authoritative.
        with_cycle = KnowledgeGraph(
            1,
            (GraphNode("kc.a"), GraphNode("kc.b")),
            (
                GraphEdge("kc.a", "kc.b", status="proposed"),
                GraphEdge("kc.b", "kc.a", status="proposed"),
            ),
        )
        self.assertFalse(with_cycle.has_cycle())
        self.assertTrue(with_cycle.has_cycle(approved_only=False))

    def test_version_store_is_append_only_and_traceable(self):
        first = make_graph()
        store = KnowledgeGraphStore([first])
        second = store.add_version(
            list(first.nodes) + [GraphNode("kc.quadratic.graph")],
            list(first.edges)
            + [GraphEdge("kc.quadratic.graph", "kc.quadratic.formula")],
        )
        self.assertEqual(store.versions(), (1, 2))
        self.assertEqual(store.latest().version, 2)
        self.assertNotEqual(first.content_hash, second.content_hash)
        diff = store.diff(1, 2)
        self.assertEqual(diff.added_nodes, ("kc.quadratic.graph",))
        self.assertEqual(
            diff.added_edges,
            ("kc.quadratic.graph|REQUIRES|kc.quadratic.formula",),
        )
        with self.assertRaises(GraphValidationError):
            store.add(first)
        with self.assertRaises(GraphValidationError):
            store.add(KnowledgeGraph(1, (GraphNode("kc.other"),)))

    def test_content_hash_is_deterministic_and_canonical(self):
        self.assertEqual(make_graph().content_hash, make_graph().content_hash)
        self.assertEqual(
            content_hash({"b": 1.0, "a": [1, 2]}),
            content_hash({"a": [1, 2], "b": 1}),
        )


class ItemBankTests(unittest.TestCase):
    def test_revision_keeps_history_and_resets_review(self):
        bank = ItemBank()
        approve(bank, "item.001", complete_annotation())
        self.assertEqual(bank.current("item.001").review_status, "approved")
        revised = bank.revise_item(
            "item.001",
            complete_annotation(difficulty=0.6, annotation_confidence=0.9),
            created_at="2026-03-02T00:00:00Z",
            expected_version=1,
        )
        self.assertEqual(revised.version, 2)
        self.assertEqual(revised.review_status, "draft")
        self.assertEqual([entry.version for entry in revised.history], [1, 2])
        self.assertNotEqual(
            revised.history[0].content_hash, revised.history[1].content_hash
        )
        self.assertEqual(
            [record.decision for record in revised.reviews],
            ["submit", "approve"],
        )
        # Approving an old version or revising with a stale expected version
        # fails closed.
        with self.assertRaises(ReviewTransitionError):
            bank.revise_item(
                "item.001", complete_annotation(), expected_version=1
            )
        self.assertEqual(bank.current("item.001").version, 2)

    def test_review_transitions_are_enforced_and_recorded(self):
        bank = ItemBank()
        bank.add_item("item.001", complete_annotation())
        with self.assertRaises(ReviewTransitionError):
            bank.review("item.001", "approve", "reviewer.synthetic.1")
        bank.submit_for_review("item.001", "reviewer.synthetic.1")
        approved = bank.review(
            "item.001", "approve", "reviewer.synthetic.1"
        )
        self.assertEqual(approved.review_status, "approved")
        self.assertEqual(approved.reviews[-1].decision, "approve")
        # A second approval is not a legal transition.
        with self.assertRaises(ReviewTransitionError):
            bank.review("item.001", "approve", "reviewer.synthetic.1")

    def test_approval_rejects_missing_annotations(self):
        bank = ItemBank()
        bank.add_item(
            "item.incomplete",
            ItemAnnotation(
                source="",
                license="",
                required_kcs=("kc.quadratic.formula",),
            ),
        )
        bank.submit_for_review("item.incomplete", "reviewer.synthetic.1")
        with self.assertRaises(ItemValidationError) as caught:
            bank.review("item.incomplete", "approve", "reviewer.synthetic.1")
        self.assertIn("missing annotations", str(caught.exception))

    def test_missing_or_low_confidence_annotations_fail_gate_closed(self):
        bank = ItemBank()
        bank.add_item(
            "item.incomplete",
            ItemAnnotation(required_kcs=("kc.quadratic.formula",)),
        )
        incomplete = bank.current("item.incomplete").to_curriculum_item()
        self.assertFalse(incomplete.annotations_complete)
        incomplete_decision = allow(incomplete, make_progress(), MODE_LEARN)
        self.assertFalse(incomplete_decision.allowed)
        self.assertIn("incomplete_annotations", incomplete_decision.reasons)

        low = complete_annotation(annotation_confidence=0.2)
        low_decision = allow(
            low.to_curriculum_item("item.low"), make_progress(), MODE_LEARN
        )
        self.assertFalse(low_decision.allowed)
        self.assertIn("low_annotation_confidence", low_decision.reasons)

    def test_unknown_item_and_version_raise(self):
        bank = ItemBank()
        with self.assertRaises(ItemNotFoundError):
            bank.current("item.unknown")
        approve(bank, "item.001", complete_annotation())
        with self.assertRaises(ItemNotFoundError):
            bank.get_version("item.001", 9)

    def test_annotation_snapshot_has_no_content_fields(self):
        annotation = complete_annotation()
        snapshot = annotation.snapshot()
        for forbidden in (
            "stem",
            "question",
            "answer",
            "answer_spec",
            "hint",
            "hints",
            "solution",
            "solution_steps",
            "image",
        ):
            self.assertNotIn(forbidden, snapshot)


class RetrievalTests(unittest.TestCase):
    def setUp(self):
        self.graph = make_graph()
        self.bank = ItemBank()
        approve(self.bank, "item.formula", complete_annotation())
        approve(
            self.bank,
            "item.algebra",
            complete_annotation(
                required_kcs=("kc.algebra.square_root",),
                curriculum_node_ids=("kc.algebra.square_root",),
                q_matrix=(QMatrixEntry("kc.algebra.square_root", 0.9),),
                difficulty=0.35,
            ),
        )
        approve(
            self.bank,
            "item.multiple",
            complete_annotation(
                item_type="multiple_choice",
                difficulty=0.8,
            ),
        )
        approve(
            self.bank,
            "item.low",
            complete_annotation(annotation_confidence=0.2),
        )
        self.bank.add_item("item.draft", complete_annotation(), review_status="draft")

    def test_search_filters_by_kc_difficulty_and_type(self):
        query = RetrievalQuery(
            kc_ids=("kc.quadratic.formula",),
            difficulty_min=0.4,
            difficulty_max=0.6,
            item_types=("short_answer",),
            limit=10,
        )
        hits = self.bank.search(query)
        self.assertEqual(
            [hit.item_id for hit in hits],
            ["item.formula", "item.low"],
        )
        for hit in hits:
            self.assertNotIn("stem", hit.summary())
            self.assertNotIn("answer", hit.summary())
            self.assertNotIn("hints", hit.summary())

    def test_search_excludes_draft_and_items_outside_filters(self):
        self.assertEqual(
            [hit.item_id for hit in self.bank.search(RetrievalQuery(item_types=("multiple_choice",)))],
            ["item.multiple"],
        )
        ids = {
            hit.item_id
            for hit in self.bank.search(
                RetrievalQuery(kc_ids=("kc.quadratic.formula",), limit=50)
            )
        }
        self.assertNotIn("item.draft", ids)
        self.assertNotIn("item.algebra", ids)
        for hit in self.bank.search(
            RetrievalQuery(kc_ids=("kc.quadratic.formula",), difficulty_min=0.7)
        ):
            self.assertNotEqual(hit.item_id, "item.formula")

    def test_retrieval_query_validation_is_fail_closed(self):
        with self.assertRaises(ItemValidationError):
            RetrievalQuery(limit=0)
        with self.assertRaises(ItemValidationError):
            RetrievalQuery(difficulty_min=0.8, difficulty_max=0.2)
        with self.assertRaises(ItemValidationError):
            RetrievalQuery(item_types=("essay",))

    def test_retrieval_plan_requires_gate_and_prerequisite_closure(self):
        plan = plan_retrieval(
            self.bank,
            self.graph,
            make_progress(),
            MODE_LEARN,
            RetrievalQuery(
                kc_ids=("kc.quadratic.formula", "kc.advanced.quadratic"),
                item_types=("short_answer",),
                limit=10,
            ),
        )
        candidate_ids = [candidate.item_id for candidate in plan.candidates]
        self.assertIn("item.formula", candidate_ids)
        self.assertNotIn("item.low", candidate_ids)
        low = next(item for item in plan.rejected if item.item_id == "item.low")
        self.assertIn("low_annotation_confidence", low.reasons)

        # Direct KC allowed by the gate, but a transitive prerequisite is not.
        bank = ItemBank()
        approve(
            bank,
            "item.advanced",
            complete_annotation(
                required_kcs=("kc.advanced.quadratic",),
                curriculum_node_ids=("kc.advanced.quadratic",),
                q_matrix=(QMatrixEntry("kc.advanced.quadratic", 0.9),),
            ),
        )
        denied = plan_retrieval(
            bank,
            self.graph,
            make_progress(),
            MODE_LEARN,
            RetrievalQuery(kc_ids=("kc.advanced.quadratic",)),
        )
        self.assertEqual(denied.candidates, ())
        self.assertEqual(
            denied.rejected[0].reasons,
            ("prerequisites_not_met:kc.calculus.derivative",),
        )

    def test_unknown_kc_and_missing_graph_fail_closed(self):
        bank = ItemBank()
        approve(
            bank,
            "item.unknown.kc",
            complete_annotation(
                required_kcs=("kc.not.in.graph",),
                curriculum_node_ids=("kc.not.in.graph",),
                q_matrix=(QMatrixEntry("kc.not.in.graph", 0.9),),
            ),
        )
        plan = plan_retrieval(
            bank,
            self.graph,
            make_progress(taught_kcs=frozenset({"kc.not.in.graph"})),
            MODE_LEARN,
            RetrievalQuery(kc_ids=("kc.not.in.graph",)),
        )
        self.assertEqual(plan.candidates, ())
        self.assertIn("kc_not_in_graph:kc.not.in.graph", plan.rejected[0].reasons)

        blocked = plan_retrieval(
            bank,
            None,
            make_progress(taught_kcs=frozenset({"kc.not.in.graph"})),
            MODE_LEARN,
            RetrievalQuery(kc_ids=("kc.not.in.graph",)),
        )
        self.assertEqual(blocked.blocked_reason, "graph_unavailable")
        self.assertEqual(blocked.candidates, ())

    def test_prerequisite_diagnostics_reports_missing_and_unknown(self):
        missing, unknown = prerequisite_diagnostics(
            self.graph,
            ("kc.advanced.quadratic", "kc.not.in.graph"),
            {"kc.quadratic.formula", "kc.algebra.square_root", "kc.arith.square_root"},
        )
        self.assertEqual(missing, ("kc.calculus.derivative",))
        self.assertEqual(unknown, ("kc.not.in.graph",))


class FixtureParityTests(unittest.TestCase):
    def test_shared_fixture_graph_and_retrieval_expectations(self):
        data = load_fixture()
        graph = graph_from_fixture(data)
        expected = data["expected"]
        self.assertEqual(graph.content_hash, expected["graphHash"])
        for kc_id, closure in expected["prerequisiteClosure"].items():
            self.assertEqual(
                sorted(graph.prerequisite_closure(kc_id)), closure
            )
        self.assertEqual(list(graph.topological_order()), expected["topologicalOrder"])
        self.assertEqual(graph.has_cycle(), expected["hasCycle"])

        bank = bank_from_fixture(data)
        plan = plan_retrieval(
            bank,
            graph,
            progress_from_fixture(data),
            data["mode"],
            data["query"],
        )
        self.assertEqual(
            [hit.item_id for hit in plan.hits], expected["hitOrder"]
        )
        self.assertEqual(
            {hit.item_id: hit.score for hit in plan.hits},
            expected["hitScores"],
        )
        self.assertEqual(
            [candidate.item_id for candidate in plan.candidates],
            expected["candidates"],
        )
        self.assertEqual(
            {item.item_id: list(item.reasons) for item in plan.rejected},
            expected["rejected"],
        )


if __name__ == "__main__":
    unittest.main()
