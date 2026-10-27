"""Curriculum knowledge space: KC graph, versioned item bank, local RAG.

This module implements the Step 9 subset of spec section 3 with the Python
standard library only:

* :class:`KnowledgeGraph` — an immutable, versioned knowledge-component graph
  with ``REQUIRES`` / ``SUPPORTS`` / ``PART_OF`` / ``ASSESSES`` and the other
  relation types from the spec.  Only *approved* ``REQUIRES`` edges are
  authoritative prerequisites; ``proposed`` edges are retained for review but
  never enter the prerequisite closure.  Illegal graphs (unknown endpoints,
  self loops, duplicate nodes/edges, dependency cycles) are rejected.
* :class:`KnowledgeGraphStore` — append-only graph versions with content hashes
  and a deterministic diff, so a curriculum change is traceable.
* :class:`ItemBank` — versioned items with structured annotations, review
  status, and an append-only review ledger.  Missing annotations are stored as
  an explicit incomplete record, and :meth:`ItemAnnotation.to_curriculum_item`
  marks them ``annotations_complete=False`` so the fail-closed curriculum gate
  rejects them.
* :meth:`ItemBank.search` — a local, deterministic, in-memory retrieval
  interface.  Hits contain only an opaque ``item_id`` plus an annotation
  summary (never item text, answers, hints, or solutions).
* :func:`plan_retrieval` — every hit is re-resolved and must pass both the
  curriculum gate *and* the prerequisite closure check before it becomes a
  candidate.  A missing graph or an unknown KC fails closed.

All examples and tests are synthetic.  The module does not read files, open a
database, use the network, or contain real student/item data.
"""

from __future__ import annotations

import hashlib
import heapq
import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Iterable, Mapping, Sequence

from .curriculum_gate import (
    DEFAULT_MIN_ANNOTATION_CONFIDENCE,
    DEFAULT_MIN_PROGRESS_CONFIDENCE,
    CurriculumItem,
    GateDecision,
    LearnerProgress,
    allow,
    allowed_kcs,
)

# ---------------------------------------------------------------------------
# Controlled vocabularies (spec section 3)
# ---------------------------------------------------------------------------

NODE_TYPES: frozenset[str] = frozenset(
    {
        "curriculum",
        "textbook",
        "lesson",
        "course_session",
        "knowledge_component",
        "subskill",
        "definition",
        "theorem",
        "strategy",
        "problem_schema",
        "solution_step",
        "misconception",
        "exercise",
        "worked_example",
        "hint",
        "learning_object",
        "assessment_rubric",
        "learning_objective",
        "prerequisite",
        "transfer_objective",
    }
)

RELATION_TYPES: frozenset[str] = frozenset(
    {
        "REQUIRES",
        "SUPPORTS",
        "PART_OF",
        "ASSESSES",
        "USES_STRATEGY",
        "CAN_FAIL_AS",
        "REMEDIATES",
        "TRANSFERS_TO",
        "IN_TEXTBOOK",
    }
)

EDGE_STATUSES: frozenset[str] = frozenset({"approved", "proposed"})

ITEM_TYPES: frozenset[str] = frozenset(
    {
        "multiple_choice",
        "short_answer",
        "worked_example",
        "diagnostic",
        "transfer",
        "open_response",
    }
)

REVIEW_STATUSES: frozenset[str] = frozenset(
    {"draft", "pending_review", "approved", "rejected", "changes_requested"}
)

REVIEW_DECISIONS: frozenset[str] = frozenset(
    {"submit", "approve", "reject", "request_changes"}
)

_OPAQUE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$")


class CurriculumGraphError(ValueError):
    """Base error for graph/item-bank/retrieval validation failures."""


class GraphValidationError(CurriculumGraphError):
    """The graph itself is illegal (cycle, duplicate, bad endpoint, ...)."""


class UnknownKnowledgeComponent(CurriculumGraphError):
    """A lookup referenced a KC that is not in this graph version."""


class ItemBankError(ValueError):
    """Base error for item-bank validation and review transitions."""


class ItemValidationError(ItemBankError):
    """An item annotation or lifecycle value is malformed."""


class ItemNotFoundError(ItemBankError):
    """The requested opaque item id is not in the bank."""


class ReviewTransitionError(ItemBankError):
    """A review/submit action is not legal for the current status/version."""


# ---------------------------------------------------------------------------
# Small shared helpers
# ---------------------------------------------------------------------------


def _opaque(value: Any, field_name: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field_name} must be a string")
    if not _OPAQUE_RE.match(value):
        raise ValueError(f"{field_name} must be a short opaque reference")
    return value


def _positive_int(value: Any, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 1:
        raise ValueError(f"{field_name} must be a positive integer")
    return value


def _non_negative_int(value: Any, field_name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{field_name} must be a non-negative integer")
    return value


def _finite(value: Any, field_name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field_name} must be a finite number")
    number = float(value)
    if number != number or number in (float("inf"), float("-inf")):
        raise ValueError(f"{field_name} must be a finite number")
    return number


def _unit_interval(value: Any, field_name: str) -> float:
    number = _finite(value, field_name)
    if number < 0.0 or number > 1.0:
        raise ValueError(f"{field_name} must be within [0, 1]")
    return number


def _text(value: Any, field_name: str, *, max_length: int = 200) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{field_name} must be a string")
    if len(value) > max_length or "\r" in value or "\n" in value:
        raise ValueError(f"{field_name} must be a short single-line string")
    return value


def _timestamp(value: Any, field_name: str = "timestamp") -> str:
    text = _text(value, field_name, max_length=64)
    if not text:
        raise ValueError(f"{field_name} is required")
    try:
        datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(f"{field_name} must be an ISO-8601 timestamp") from exc
    return text


def _id_tuple(values: Any, field_name: str) -> tuple[str, ...]:
    if values is None:
        return ()
    if isinstance(values, (str, bytes)) or not isinstance(values, Iterable):
        raise ValueError(f"{field_name} must be an iterable of opaque ids")
    result: list[str] = []
    seen: set[str] = set()
    for value in values:
        item = _opaque(value, field_name)
        if item in seen:
            raise ValueError(f"{field_name} contains duplicate id: {item}")
        seen.add(item)
        result.append(item)
    return tuple(result)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _normalise_numbers(value: Any) -> Any:
    """Make Python/TypeScript canonical JSON agree on integer-valued floats."""
    if isinstance(value, bool) or value is None or isinstance(value, str):
        return value
    if isinstance(value, float):
        if value == 0.0:
            return 0
        if value.is_integer():
            return int(value)
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, Mapping):
        return {str(key): _normalise_numbers(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_normalise_numbers(item) for item in value]
    raise TypeError(f"cannot canonicalise value of type {type(value).__name__}")


def canonical_json(value: Any) -> str:
    """Stable JSON used for content hashes on both the Python and TS sides."""
    return json.dumps(
        _normalise_numbers(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    )


def content_hash(value: Any) -> str:
    """SHA-256 over :func:`canonical_json` (integrity, not a signature)."""
    return hashlib.sha256(canonical_json(value).encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# Knowledge graph
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class GraphNode:
    """One curriculum graph node. No real textbook content is stored here."""

    node_id: str
    node_type: str = "knowledge_component"
    concept_id: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "node_id", _opaque(self.node_id, "node_id"))
        if self.node_type not in NODE_TYPES:
            raise GraphValidationError(f"unknown node_type: {self.node_type}")
        if self.concept_id is not None:
            object.__setattr__(
                self, "concept_id", _opaque(self.concept_id, "concept_id")
            )

    @classmethod
    def from_value(cls, value: Any) -> "GraphNode":
        if isinstance(value, GraphNode):
            return value
        if isinstance(value, Mapping):
            return cls(
                node_id=value.get("node_id", value.get("nodeId")),
                node_type=value.get("node_type", value.get("nodeType", "knowledge_component")),
                concept_id=value.get("concept_id", value.get("conceptId")),
            )
        raise GraphValidationError("graph node must be a mapping or GraphNode")

    def snapshot(self) -> dict[str, Any]:
        return {
            "node_id": self.node_id,
            "node_type": self.node_type,
            "concept_id": self.concept_id,
        }


@dataclass(frozen=True)
class GraphEdge:
    """A directed relation. ``source REQUIRES target`` means target is prior."""

    source_id: str
    target_id: str
    relation: str = "REQUIRES"
    status: str = "approved"
    confidence: float = 1.0
    provenance: str = "synthetic"

    def __post_init__(self) -> None:
        object.__setattr__(
            self, "source_id", _opaque(self.source_id, "source_id")
        )
        object.__setattr__(
            self, "target_id", _opaque(self.target_id, "target_id")
        )
        if self.relation not in RELATION_TYPES:
            raise GraphValidationError(f"unknown relation: {self.relation}")
        if self.status not in EDGE_STATUSES:
            raise GraphValidationError(f"unknown edge status: {self.status}")
        object.__setattr__(
            self, "confidence", _unit_interval(self.confidence, "confidence")
        )
        object.__setattr__(
            self, "provenance", _text(self.provenance, "provenance", max_length=120)
        )

    @classmethod
    def from_value(cls, value: Any) -> "GraphEdge":
        if isinstance(value, GraphEdge):
            return value
        if isinstance(value, Mapping):
            return cls(
                source_id=value.get("source_id", value.get("sourceId")),
                target_id=value.get("target_id", value.get("targetId")),
                relation=value.get("relation", "REQUIRES"),
                status=value.get("status", "approved"),
                confidence=value.get("confidence", 1.0),
                provenance=value.get("provenance", "synthetic"),
            )
        raise GraphValidationError("graph edge must be a mapping or GraphEdge")

    def key(self) -> tuple[str, str, str]:
        return (self.source_id, self.target_id, self.relation)

    def snapshot(self) -> dict[str, Any]:
        return {
            "source_id": self.source_id,
            "target_id": self.target_id,
            "relation": self.relation,
            "status": self.status,
            "confidence": self.confidence,
            "provenance": self.provenance,
        }


class KnowledgeGraph:
    """Immutable, validated curriculum graph version.

    Dependency direction: ``A --REQUIRES--> B`` means A needs B first, so
    ``prerequisite_closure(A)`` contains B and B's own prerequisites.
    """

    def __init__(
        self,
        version: int,
        nodes: Iterable[Any],
        edges: Iterable[Any] = (),
    ) -> None:
        self.version = _positive_int(version, "version")

        nodes_by_id: dict[str, GraphNode] = {}
        for raw in nodes:
            node = GraphNode.from_value(raw)
            if node.node_id in nodes_by_id:
                raise GraphValidationError(f"duplicate node id: {node.node_id}")
            nodes_by_id[node.node_id] = node
        if not nodes_by_id:
            raise GraphValidationError("graph must contain at least one node")

        edges_by_key: dict[tuple[str, str, str], GraphEdge] = {}
        for raw in edges:
            edge = GraphEdge.from_value(raw)
            if edge.source_id not in nodes_by_id:
                raise GraphValidationError(f"unknown edge source: {edge.source_id}")
            if edge.target_id not in nodes_by_id:
                raise GraphValidationError(f"unknown edge target: {edge.target_id}")
            if edge.source_id == edge.target_id:
                raise GraphValidationError(
                    f"self loop is not allowed: {edge.source_id}"
                )
            if edge.key() in edges_by_key:
                raise GraphValidationError(
                    "duplicate edge: "
                    f"{edge.source_id} -{edge.relation}-> {edge.target_id}"
                )
            edges_by_key[edge.key()] = edge

        self._nodes_by_id = nodes_by_id
        self._edges = tuple(
            sorted(edges_by_key.values(), key=lambda edge: (edge.source_id, edge.target_id, edge.relation, edge.status))
        )
        self.nodes = tuple(nodes_by_id[node_id] for node_id in sorted(nodes_by_id))
        self.edges = self._edges
        self._requires = self._adjacency("REQUIRES")
        self._part_of = self._adjacency("PART_OF")

        for relation, adjacency, label in (
            ("REQUIRES", self._requires, "prerequisite"),
            ("PART_OF", self._part_of, "part-of"),
        ):
            if _has_cycle(adjacency):
                raise GraphValidationError(
                    f"{label} cycle detected in approved {relation} edges"
                )
            if _has_self_loop(adjacency):
                raise GraphValidationError(f"{label} self loop detected")

        self.content_hash = content_hash(self.snapshot())

    def _adjacency(self, relation: str) -> dict[str, tuple[str, ...]]:
        result: dict[str, list[str]] = {node_id: [] for node_id in self._nodes_by_id}
        for edge in self._edges:
            if edge.relation == relation and edge.status == "approved":
                result[edge.source_id].append(edge.target_id)
        return {
            node_id: tuple(sorted(targets))
            for node_id, targets in result.items()
        }

    def snapshot(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "nodes": [node.snapshot() for node in self.nodes],
            "edges": [edge.snapshot() for edge in self.edges],
        }

    @property
    def nodes_by_id(self) -> Mapping[str, GraphNode]:
        """Read-only mapping of node id to node (for prerequisite checks)."""
        return self._nodes_by_id

    def prerequisites_of(self, kc_id: str) -> tuple[str, ...]:
        """Direct approved ``REQUIRES`` targets of ``kc_id``."""
        if kc_id not in self._nodes_by_id:
            raise UnknownKnowledgeComponent(f"unknown knowledge component: {kc_id}")
        return self._requires.get(kc_id, ())

    def prerequisite_closure(
        self, kc_id: str, *, include_self: bool = False
    ) -> frozenset[str]:
        """All transitive approved prerequisites of ``kc_id``."""
        if kc_id not in self._nodes_by_id:
            raise UnknownKnowledgeComponent(f"unknown knowledge component: {kc_id}")
        seen: set[str] = set()
        stack = list(self._requires.get(kc_id, ()))
        while stack:
            current = stack.pop()
            if current in seen:
                continue
            seen.add(current)
            stack.extend(self._requires.get(current, ()))
        if include_self:
            seen.add(kc_id)
        return frozenset(seen)

    def has_cycle(
        self, relation: str = "REQUIRES", *, approved_only: bool = True
    ) -> bool:
        """Whether the selected relation contains a directed cycle."""
        if relation not in RELATION_TYPES:
            raise GraphValidationError(f"unknown relation: {relation}")
        if approved_only:
            adjacency = self._requires if relation == "REQUIRES" else (
                self._part_of if relation == "PART_OF" else self._adjacency(relation)
            )
        else:
            adjacency = self._adjacency_all(relation)
        return _has_cycle(adjacency)

    def _adjacency_all(self, relation: str) -> dict[str, tuple[str, ...]]:
        result: dict[str, list[str]] = {node_id: [] for node_id in self._nodes_by_id}
        for edge in self._edges:
            if edge.relation == relation:
                result[edge.source_id].append(edge.target_id)
        return {key: tuple(sorted(value)) for key, value in result.items()}

    def topological_order(
        self, relation: str = "REQUIRES", *, approved_only: bool = True
    ) -> tuple[str, ...]:
        """Deterministic dependency-first order for one relation."""
        if relation not in RELATION_TYPES:
            raise GraphValidationError(f"unknown relation: {relation}")
        adjacency = (
            self._requires
            if relation == "REQUIRES" and approved_only
            else self._part_of
            if relation == "PART_OF" and approved_only
            else self._adjacency(relation)
            if approved_only
            else self._adjacency_all(relation)
        )
        indegree = {node_id: len(adjacency.get(node_id, ())) for node_id in self._nodes_by_id}
        dependents: dict[str, list[str]] = {node_id: [] for node_id in self._nodes_by_id}
        for source, targets in adjacency.items():
            for target in targets:
                dependents[target].append(source)
        ready = [node_id for node_id, degree in indegree.items() if degree == 0]
        heapq.heapify(ready)
        order: list[str] = []
        while ready:
            node_id = heapq.heappop(ready)
            order.append(node_id)
            for dependent in dependents.get(node_id, ()):
                indegree[dependent] -= 1
                if indegree[dependent] == 0:
                    heapq.heappush(ready, dependent)
        if len(order) != len(self._nodes_by_id):
            raise GraphValidationError(f"cycle detected in {relation} edges")
        return tuple(order)


def _has_self_loop(adjacency: Mapping[str, Sequence[str]]) -> bool:
    return any(source in targets for source, targets in adjacency.items())


def _has_cycle(adjacency: Mapping[str, Sequence[str]]) -> bool:
    indegree = {node_id: 0 for node_id in adjacency}
    for targets in adjacency.values():
        for target in targets:
            indegree[target] = indegree.get(target, 0) + 1
    ready = [node_id for node_id, degree in indegree.items() if degree == 0]
    visited = 0
    while ready:
        node_id = ready.pop()
        visited += 1
        for target in adjacency.get(node_id, ()):
            indegree[target] -= 1
            if indegree[target] == 0:
                ready.append(target)
    return visited != len(indegree)


@dataclass(frozen=True)
class GraphDiff:
    """Deterministic node/edge difference between two graph versions."""

    from_version: int
    to_version: int
    added_nodes: tuple[str, ...]
    removed_nodes: tuple[str, ...]
    added_edges: tuple[str, ...]
    removed_edges: tuple[str, ...]


class KnowledgeGraphStore:
    """Append-only graph version history (versions must strictly increase)."""

    def __init__(self, graphs: Iterable[KnowledgeGraph] = ()) -> None:
        self._by_version: dict[int, KnowledgeGraph] = {}
        self._versions: list[int] = []
        for graph in graphs:
            self.add(graph)

    def add(self, graph: KnowledgeGraph) -> KnowledgeGraph:
        if not isinstance(graph, KnowledgeGraph):
            raise GraphValidationError("only validated KnowledgeGraph values can be stored")
        if graph.version in self._by_version:
            raise GraphValidationError(f"graph version already exists: {graph.version}")
        if self._versions and graph.version <= self._versions[-1]:
            raise GraphValidationError(
                f"graph version must increase: {graph.version} <= {self._versions[-1]}"
            )
        self._by_version[graph.version] = graph
        self._versions.append(graph.version)
        return graph

    def add_version(
        self,
        nodes: Iterable[Any],
        edges: Iterable[Any] = (),
        *,
        version: int | None = None,
    ) -> KnowledgeGraph:
        next_version = version if version is not None else (
            self._versions[-1] + 1 if self._versions else 1
        )
        return self.add(KnowledgeGraph(next_version, nodes, edges))

    def get(self, version: int) -> KnowledgeGraph:
        try:
            return self._by_version[version]
        except KeyError as exc:
            raise GraphValidationError(f"unknown graph version: {version}") from exc

    def latest(self) -> KnowledgeGraph:
        if not self._versions:
            raise GraphValidationError("graph store is empty")
        return self._by_version[self._versions[-1]]

    def versions(self) -> tuple[int, ...]:
        return tuple(self._versions)

    def history(self) -> tuple[KnowledgeGraph, ...]:
        return tuple(self._by_version[version] for version in self._versions)

    def diff(self, from_version: int, to_version: int) -> GraphDiff:
        before = self.get(from_version)
        after = self.get(to_version)
        before_nodes = {node.node_id for node in before.nodes}
        after_nodes = {node.node_id for node in after.nodes}
        before_edges = {
            f"{edge.source_id}|{edge.relation}|{edge.target_id}"
            for edge in before.edges
        }
        after_edges = {
            f"{edge.source_id}|{edge.relation}|{edge.target_id}"
            for edge in after.edges
        }
        return GraphDiff(
            from_version=from_version,
            to_version=to_version,
            added_nodes=tuple(sorted(after_nodes - before_nodes)),
            removed_nodes=tuple(sorted(before_nodes - after_nodes)),
            added_edges=tuple(sorted(after_edges - before_edges)),
            removed_edges=tuple(sorted(before_edges - after_edges)),
        )


# ---------------------------------------------------------------------------
# Item annotations, versions, and review ledger
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class QMatrixEntry:
    """One ``(KC, confidence)`` cell of an item's Q-matrix."""

    kc_id: str
    confidence: float = 1.0

    def __post_init__(self) -> None:
        object.__setattr__(self, "kc_id", _opaque(self.kc_id, "kc_id"))
        object.__setattr__(
            self, "confidence", _unit_interval(self.confidence, "q_matrix.confidence")
        )

    @classmethod
    def from_value(cls, value: Any) -> "QMatrixEntry":
        if isinstance(value, QMatrixEntry):
            return value
        if isinstance(value, Mapping):
            return cls(
                kc_id=value.get("kc_id", value.get("kcId")),
                confidence=value.get("confidence", 1.0),
            )
        raise ItemValidationError("q_matrix entry must be a mapping or QMatrixEntry")

    def snapshot(self) -> dict[str, Any]:
        return {"kc_id": self.kc_id, "confidence": self.confidence}


MISSING_ANNOTATION_FIELDS: tuple[str, ...] = (
    "source",
    "license",
    "stage",
    "course",
    "grade_level",
    "curriculum_node_ids",
    "required_kcs",
    "q_matrix",
    "difficulty",
    "item_type",
    "estimated_minutes",
    "verifier_type",
    "safety_checked",
    "content_verified",
    "correctness_verified",
    "annotation_confidence",
)


@dataclass(frozen=True)
class ItemAnnotation:
    """Structured, content-free item annotations (synthetic only)."""

    source: str = "synthetic"
    license: str = "synthetic-only"
    stage: str = "secondary"
    course: str = "synthetic.course"
    grade_level: int | None = None
    curriculum_node_ids: tuple[str, ...] = ()
    required_kcs: tuple[str, ...] = ()
    forbidden_future_kcs: tuple[str, ...] = ()
    q_matrix: tuple[QMatrixEntry, ...] = ()
    strategy_ids: tuple[str, ...] = ()
    misconception_targets: tuple[str, ...] = ()
    difficulty: float | None = None
    item_type: str | None = None
    estimated_minutes: float | None = None
    verifier_type: str | None = None
    hint_leakage_level: int = 0
    near_transfer_ids: tuple[str, ...] = ()
    far_transfer_ids: tuple[str, ...] = ()
    safety_checked: bool = False
    content_verified: bool = False
    correctness_verified: bool = False
    annotation_confidence: float | None = None
    cognitive_load: float = 0.0
    exposure_count: int = 0
    extension_approved: bool = False

    def __post_init__(self) -> None:
        for name in ("source", "license", "stage", "course"):
            object.__setattr__(
                self, name, _text(getattr(self, name), name, max_length=120)
            )
        if self.grade_level is not None:
            object.__setattr__(
                self, "grade_level", _positive_int(self.grade_level, "grade_level")
            )
        for name in (
            "curriculum_node_ids",
            "required_kcs",
            "forbidden_future_kcs",
            "strategy_ids",
            "misconception_targets",
            "near_transfer_ids",
            "far_transfer_ids",
        ):
            object.__setattr__(self, name, _id_tuple(getattr(self, name), name))
        q_entries: list[QMatrixEntry] = []
        seen_kcs: set[str] = set()
        raw_q_matrix = self.q_matrix or ()
        if isinstance(raw_q_matrix, (str, bytes)) or not isinstance(raw_q_matrix, Iterable):
            raise ItemValidationError("q_matrix must be an iterable")
        for raw in raw_q_matrix:
            entry = QMatrixEntry.from_value(raw)
            if entry.kc_id in seen_kcs:
                raise ItemValidationError(f"duplicate q_matrix kc_id: {entry.kc_id}")
            seen_kcs.add(entry.kc_id)
            q_entries.append(entry)
        object.__setattr__(self, "q_matrix", tuple(q_entries))

        if self.difficulty is not None:
            object.__setattr__(
                self, "difficulty", _unit_interval(self.difficulty, "difficulty")
            )
        if self.item_type is not None and self.item_type not in ITEM_TYPES:
            raise ItemValidationError(f"unknown item_type: {self.item_type}")
        if self.estimated_minutes is not None:
            minutes = _finite(self.estimated_minutes, "estimated_minutes")
            if minutes <= 0:
                raise ItemValidationError("estimated_minutes must be positive")
            object.__setattr__(self, "estimated_minutes", minutes)
        if self.verifier_type is not None:
            object.__setattr__(
                self,
                "verifier_type",
                _text(self.verifier_type, "verifier_type", max_length=120),
            )
        object.__setattr__(
            self,
            "hint_leakage_level",
            _non_negative_int(self.hint_leakage_level, "hint_leakage_level"),
        )
        if self.hint_leakage_level > 3:
            raise ItemValidationError("hint_leakage_level must be within [0, 3]")
        for name in ("safety_checked", "content_verified", "correctness_verified", "extension_approved"):
            if not isinstance(getattr(self, name), bool):
                raise ItemValidationError(f"{name} must be a boolean")
        if self.annotation_confidence is not None:
            object.__setattr__(
                self,
                "annotation_confidence",
                _unit_interval(self.annotation_confidence, "annotation_confidence"),
            )
        object.__setattr__(
            self, "cognitive_load", _finite(self.cognitive_load, "cognitive_load")
        )
        if self.cognitive_load < 0:
            raise ItemValidationError("cognitive_load must be non-negative")
        object.__setattr__(
            self,
            "exposure_count",
            _non_negative_int(self.exposure_count, "exposure_count"),
        )

    @classmethod
    def from_value(cls, value: Any) -> "ItemAnnotation":
        if isinstance(value, ItemAnnotation):
            return value
        if not isinstance(value, Mapping):
            raise ItemValidationError("annotation must be a mapping or ItemAnnotation")

        def pick(snake: str, camel: str, default: Any = None) -> Any:
            return value.get(snake, value.get(camel, default))

        return cls(
            source=pick("source", "source", "synthetic"),
            license=pick("license", "license", "synthetic-only"),
            stage=pick("stage", "stage", "secondary"),
            course=pick("course", "course", "synthetic.course"),
            grade_level=pick("grade_level", "gradeLevel"),
            curriculum_node_ids=pick("curriculum_node_ids", "curriculumNodeIds", ()),
            required_kcs=pick("required_kcs", "requiredKcs", ()),
            forbidden_future_kcs=pick("forbidden_future_kcs", "forbiddenFutureKcs", ()),
            q_matrix=pick("q_matrix", "qMatrix", ()),
            strategy_ids=pick("strategy_ids", "strategyIds", ()),
            misconception_targets=pick("misconception_targets", "misconceptionTargets", ()),
            difficulty=pick("difficulty", "difficulty"),
            item_type=pick("item_type", "itemType"),
            estimated_minutes=pick("estimated_minutes", "estimatedMinutes"),
            verifier_type=pick("verifier_type", "verifierType"),
            hint_leakage_level=pick("hint_leakage_level", "hintLeakageLevel", 0),
            near_transfer_ids=pick("near_transfer_ids", "nearTransferIds", ()),
            far_transfer_ids=pick("far_transfer_ids", "farTransferIds", ()),
            safety_checked=pick("safety_checked", "safetyChecked", False),
            content_verified=pick("content_verified", "contentVerified", False),
            correctness_verified=pick("correctness_verified", "correctnessVerified", False),
            annotation_confidence=pick("annotation_confidence", "annotationConfidence"),
            cognitive_load=pick("cognitive_load", "cognitiveLoad", 0.0),
            exposure_count=pick("exposure_count", "exposureCount", 0),
            extension_approved=pick("extension_approved", "extensionApproved", False),
        )

    def missing_annotation_fields(self) -> tuple[str, ...]:
        """Spec-required tags that are absent; used to fail closed."""
        missing: list[str] = []
        for name in ("source", "license", "stage", "course"):
            if not getattr(self, name):
                missing.append(name)
        if self.grade_level is None:
            missing.append("grade_level")
        if not self.curriculum_node_ids:
            missing.append("curriculum_node_ids")
        if not self.required_kcs:
            missing.append("required_kcs")
        if not self.q_matrix:
            missing.append("q_matrix")
        if self.difficulty is None:
            missing.append("difficulty")
        if self.item_type is None:
            missing.append("item_type")
        if self.estimated_minutes is None:
            missing.append("estimated_minutes")
        if not self.verifier_type:
            missing.append("verifier_type")
        if not self.safety_checked:
            missing.append("safety_checked")
        if not self.content_verified:
            missing.append("content_verified")
        if not self.correctness_verified:
            missing.append("correctness_verified")
        if self.annotation_confidence is None:
            missing.append("annotation_confidence")
        return tuple(missing)

    def complete(self) -> bool:
        return not self.missing_annotation_fields()

    def to_curriculum_item(self, item_id: str) -> CurriculumItem:
        """Map to the gate item, explicitly marking incomplete annotations."""
        missing = self.missing_annotation_fields()
        role = (
            self.item_type
            if self.item_type in {"training", "transfer", "explanation", "diagnostic"}
            else "training"
        )
        return CurriculumItem(
            item_id=item_id,
            required_kcs=self.required_kcs,
            grade_level=self.grade_level,
            safety_checked=self.safety_checked,
            content_verified=self.content_verified,
            annotation_confidence=self.annotation_confidence,
            future_methods=self.forbidden_future_kcs,
            cognitive_load=self.cognitive_load,
            extension_approved=self.extension_approved,
            role=role,
            annotations_complete=not missing,
        )

    def snapshot(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "license": self.license,
            "stage": self.stage,
            "course": self.course,
            "grade_level": self.grade_level,
            "curriculum_node_ids": list(self.curriculum_node_ids),
            "required_kcs": list(self.required_kcs),
            "forbidden_future_kcs": list(self.forbidden_future_kcs),
            "q_matrix": [entry.snapshot() for entry in self.q_matrix],
            "strategy_ids": list(self.strategy_ids),
            "misconception_targets": list(self.misconception_targets),
            "difficulty": self.difficulty,
            "item_type": self.item_type,
            "estimated_minutes": self.estimated_minutes,
            "verifier_type": self.verifier_type,
            "hint_leakage_level": self.hint_leakage_level,
            "near_transfer_ids": list(self.near_transfer_ids),
            "far_transfer_ids": list(self.far_transfer_ids),
            "safety_checked": self.safety_checked,
            "content_verified": self.content_verified,
            "correctness_verified": self.correctness_verified,
            "annotation_confidence": self.annotation_confidence,
            "cognitive_load": self.cognitive_load,
            "exposure_count": self.exposure_count,
            "extension_approved": self.extension_approved,
        }


@dataclass(frozen=True)
class ItemVersion:
    """One immutable item version (annotation content only)."""

    item_id: str
    version: int
    annotation: ItemAnnotation
    created_at: str
    content_hash: str

    def snapshot(self) -> dict[str, Any]:
        return {
            "item_id": self.item_id,
            "version": self.version,
            "annotation": self.annotation.snapshot(),
            "created_at": self.created_at,
            "content_hash": self.content_hash,
        }


@dataclass(frozen=True)
class ItemReviewRecord:
    """Append-only review/submission ledger entry."""

    item_id: str
    item_version: int
    decision: str
    reviewer_ref: str
    reviewed_at: str
    note: str = ""

    def __post_init__(self) -> None:
        if self.decision not in REVIEW_DECISIONS:
            raise ItemValidationError(f"unknown review decision: {self.decision}")
        object.__setattr__(
            self, "item_id", _opaque(self.item_id, "item_id")
        )
        object.__setattr__(
            self, "item_version", _positive_int(self.item_version, "item_version")
        )
        object.__setattr__(
            self, "reviewer_ref", _opaque(self.reviewer_ref, "reviewer_ref")
        )
        object.__setattr__(self, "reviewed_at", _timestamp(self.reviewed_at, "reviewed_at"))
        object.__setattr__(self, "note", _text(self.note, "note", max_length=500))

    def snapshot(self) -> dict[str, Any]:
        return {
            "item_id": self.item_id,
            "item_version": self.item_version,
            "decision": self.decision,
            "reviewer_ref": self.reviewer_ref,
            "reviewed_at": self.reviewed_at,
            "note": self.note,
        }


@dataclass(frozen=True)
class ItemRecord:
    """Current view of an item plus its full version/review trail."""

    item_id: str
    version: int
    annotation: ItemAnnotation
    review_status: str
    created_at: str
    content_hash: str
    history: tuple[ItemVersion, ...] = field(default_factory=tuple)
    reviews: tuple[ItemReviewRecord, ...] = field(default_factory=tuple)

    def to_curriculum_item(self) -> CurriculumItem:
        return self.annotation.to_curriculum_item(self.item_id)


def _item_content_hash(item_id: str, version: int, annotation: ItemAnnotation) -> str:
    return content_hash(
        {
            "item_id": item_id,
            "version": version,
            "annotation": annotation.snapshot(),
        }
    )


class ItemBank:
    """Versioned synthetic item bank with review status and local retrieval."""

    def __init__(self) -> None:
        self._versions: dict[str, list[ItemVersion]] = {}
        self._status: dict[str, str] = {}
        self._reviews: dict[str, list[ItemReviewRecord]] = {}

    # -- lifecycle ---------------------------------------------------------

    def add_item(
        self,
        item_id: str,
        annotation: ItemAnnotation | Mapping[str, Any],
        *,
        version: int = 1,
        review_status: str = "draft",
        created_at: str | None = None,
    ) -> ItemRecord:
        item_id = _opaque(item_id, "item_id")
        if item_id in self._versions:
            raise ItemValidationError(f"item already exists: {item_id}")
        if version != 1:
            raise ItemValidationError("new items must start at version 1")
        if review_status not in REVIEW_STATUSES:
            raise ItemValidationError(f"unknown review_status: {review_status}")
        normalized = ItemAnnotation.from_value(annotation)
        created = _timestamp(created_at or _now(), "created_at")
        record_version = ItemVersion(
            item_id=item_id,
            version=version,
            annotation=normalized,
            created_at=created,
            content_hash=_item_content_hash(item_id, version, normalized),
        )
        self._versions[item_id] = [record_version]
        self._status[item_id] = review_status
        self._reviews[item_id] = []
        return self.current(item_id)

    def revise_item(
        self,
        item_id: str,
        annotation: ItemAnnotation | Mapping[str, Any],
        *,
        created_at: str | None = None,
        expected_version: int | None = None,
    ) -> ItemRecord:
        item_id = _opaque(item_id, "item_id")
        versions = self._versions.get(item_id)
        if versions is None:
            raise ItemNotFoundError(f"unknown item: {item_id}")
        current = versions[-1]
        self._assert_expected(item_id, expected_version)
        normalized = ItemAnnotation.from_value(annotation)
        next_version = current.version + 1
        created = _timestamp(created_at or _now(), "created_at")
        versions.append(
            ItemVersion(
                item_id=item_id,
                version=next_version,
                annotation=normalized,
                created_at=created,
                content_hash=_item_content_hash(item_id, next_version, normalized),
            )
        )
        # A content revision always resets review; old approvals do not carry.
        self._status[item_id] = "draft"
        return self.current(item_id)

    def submit_for_review(
        self,
        item_id: str,
        submitted_by: str,
        *,
        submitted_at: str | None = None,
        expected_version: int | None = None,
        note: str = "",
    ) -> ItemRecord:
        item_id = _opaque(item_id, "item_id")
        self._require_item(item_id)
        self._assert_expected(item_id, expected_version)
        status = self._status[item_id]
        if status not in {"draft", "changes_requested"}:
            raise ReviewTransitionError(
                f"cannot submit {item_id} from status {status}"
            )
        self._append_review(
            item_id,
            decision="submit",
            reviewer_ref=submitted_by,
            reviewed_at=submitted_at or _now(),
            note=note,
        )
        self._status[item_id] = "pending_review"
        return self.current(item_id)

    def review(
        self,
        item_id: str,
        decision: str,
        reviewer_ref: str,
        *,
        reviewed_at: str | None = None,
        note: str = "",
        expected_version: int | None = None,
    ) -> ItemRecord:
        item_id = _opaque(item_id, "item_id")
        self._require_item(item_id)
        self._assert_expected(item_id, expected_version)
        if decision not in {"approve", "reject", "request_changes"}:
            raise ItemValidationError(f"invalid review decision: {decision}")
        status = self._status[item_id]
        current = self.current(item_id)
        if decision == "approve":
            if status != "pending_review":
                raise ReviewTransitionError(
                    f"cannot approve {item_id} from status {status}"
                )
            missing = current.annotation.missing_annotation_fields()
            if missing:
                raise ItemValidationError(
                    "cannot approve item with missing annotations: "
                    + ",".join(missing)
                )
            self._status[item_id] = "approved"
        elif decision == "reject":
            if status not in {"pending_review", "approved"}:
                raise ReviewTransitionError(
                    f"cannot reject {item_id} from status {status}"
                )
            self._status[item_id] = "rejected"
        else:  # request_changes
            if status not in {"pending_review", "approved"}:
                raise ReviewTransitionError(
                    f"cannot request changes for {item_id} from status {status}"
                )
            self._status[item_id] = "changes_requested"
        self._append_review(
            item_id,
            decision=decision,
            reviewer_ref=reviewer_ref,
            reviewed_at=reviewed_at or _now(),
            note=note,
        )
        return self.current(item_id)

    def _append_review(
        self,
        item_id: str,
        *,
        decision: str,
        reviewer_ref: str,
        reviewed_at: str,
        note: str,
    ) -> None:
        current = self._versions[item_id][-1]
        self._reviews[item_id].append(
            ItemReviewRecord(
                item_id=item_id,
                item_version=current.version,
                decision=decision,
                reviewer_ref=reviewer_ref,
                reviewed_at=reviewed_at,
                note=note,
            )
        )

    def _require_item(self, item_id: str) -> list[ItemVersion]:
        versions = self._versions.get(item_id)
        if versions is None:
            raise ItemNotFoundError(f"unknown item: {item_id}")
        return versions

    def _assert_expected(self, item_id: str, expected_version: int | None) -> None:
        if expected_version is None:
            return
        current = self._versions[item_id][-1]
        if current.version != expected_version:
            raise ReviewTransitionError(
                f"version conflict for {item_id}: expected {expected_version}, "
                f"current {current.version}"
            )

    # -- reads -------------------------------------------------------------

    def current(self, item_id: str) -> ItemRecord:
        item_id = _opaque(item_id, "item_id")
        versions = self._require_item(item_id)
        current = versions[-1]
        return ItemRecord(
            item_id=item_id,
            version=current.version,
            annotation=current.annotation,
            review_status=self._status[item_id],
            created_at=current.created_at,
            content_hash=current.content_hash,
            history=tuple(versions),
            reviews=tuple(self._reviews[item_id]),
        )

    def get_version(self, item_id: str, version: int) -> ItemVersion:
        item_id = _opaque(item_id, "item_id")
        versions = self._require_item(item_id)
        for entry in versions:
            if entry.version == version:
                return entry
        raise ItemNotFoundError(f"unknown item version: {item_id}@{version}")

    def history(self, item_id: str) -> tuple[ItemVersion, ...]:
        item_id = _opaque(item_id, "item_id")
        return tuple(self._require_item(item_id))

    def reviews(self, item_id: str) -> tuple[ItemReviewRecord, ...]:
        item_id = _opaque(item_id, "item_id")
        self._require_item(item_id)
        return tuple(self._reviews[item_id])

    def list_current(self) -> tuple[ItemRecord, ...]:
        return tuple(self.current(item_id) for item_id in sorted(self._versions))

    # -- local in-memory RAG ----------------------------------------------

    def search(
        self, query: RetrievalQuery | Mapping[str, Any] | None = None
    ) -> tuple["RetrievalHit", ...]:
        """Deterministic retrieval by KC, difficulty, and item type.

        Only current, approved items are indexed.  Hits expose an opaque id
        and an annotation summary; item text/answer/hint/solution is never a
        field of this module.
        """
        normalized = _normalize_query(query)
        hits: list[RetrievalHit] = []
        for record in self.list_current():
            if record.review_status != "approved":
                continue
            annotation = record.annotation
            item_kcs = set(annotation.required_kcs)
            q_matrix_kcs = {entry.kc_id for entry in annotation.q_matrix}
            score = 0
            if normalized.kc_ids:
                required_matches = len(item_kcs & set(normalized.kc_ids))
                q_matches = len(q_matrix_kcs & set(normalized.kc_ids))
                if required_matches == 0 and q_matches == 0:
                    continue
                score += 400 * required_matches + 200 * q_matches
            if normalized.item_types:
                if annotation.item_type not in normalized.item_types:
                    continue
                score += 100
            if normalized.difficulty_min is not None or normalized.difficulty_max is not None:
                if annotation.difficulty is None:
                    continue
                if (
                    normalized.difficulty_min is not None
                    and annotation.difficulty < normalized.difficulty_min
                ):
                    continue
                if (
                    normalized.difficulty_max is not None
                    and annotation.difficulty > normalized.difficulty_max
                ):
                    continue
                score += 100
            if normalized.difficulty_target is not None:
                if annotation.difficulty is None:
                    continue
                closeness = 1.0 - abs(
                    annotation.difficulty - normalized.difficulty_target
                )
                score += max(0, int(closeness * 1000))
            if annotation.annotation_confidence is not None:
                score += int(annotation.annotation_confidence * 100)
            score -= min(annotation.exposure_count, 100)
            hits.append(
                RetrievalHit(
                    item_id=record.item_id,
                    score=score,
                    required_kcs=annotation.required_kcs,
                    q_matrix_kcs=tuple(sorted(q_matrix_kcs)),
                    difficulty=annotation.difficulty,
                    item_type=annotation.item_type,
                    annotation_confidence=annotation.annotation_confidence,
                    review_status=record.review_status,
                    version=record.version,
                    estimated_minutes=annotation.estimated_minutes,
                    grade_level=annotation.grade_level,
                )
            )
        hits.sort(key=lambda hit: (-hit.score, hit.item_id))
        return tuple(hits[: normalized.limit])


@dataclass(frozen=True)
class RetrievalQuery:
    """Validated retrieval filters.  All filters are conjunctive."""

    kc_ids: tuple[str, ...] = ()
    difficulty_min: float | None = None
    difficulty_max: float | None = None
    difficulty_target: float | None = None
    item_types: tuple[str, ...] = ()
    limit: int = 10

    def __post_init__(self) -> None:
        object.__setattr__(self, "kc_ids", _id_tuple(self.kc_ids, "kc_ids"))
        if not isinstance(self.item_types, (tuple, list, frozenset, set)):
            raise ItemValidationError("item_types must be an iterable")
        types = tuple(self.item_types)
        for item_type in types:
            if item_type not in ITEM_TYPES:
                raise ItemValidationError(f"unknown item_type: {item_type}")
        object.__setattr__(self, "item_types", types)
        for name in ("difficulty_min", "difficulty_max", "difficulty_target"):
            value = getattr(self, name)
            if value is not None:
                object.__setattr__(self, name, _unit_interval(value, name))
        if (
            self.difficulty_min is not None
            and self.difficulty_max is not None
            and self.difficulty_min > self.difficulty_max
        ):
            raise ItemValidationError("difficulty_min must be <= difficulty_max")
        if isinstance(self.limit, bool) or not isinstance(self.limit, int):
            raise ItemValidationError("limit must be an integer")
        if self.limit < 1 or self.limit > 50:
            raise ItemValidationError("limit must be within [1, 50]")


def _normalize_query(value: RetrievalQuery | Mapping[str, Any] | None) -> RetrievalQuery:
    if value is None:
        return RetrievalQuery()
    if isinstance(value, RetrievalQuery):
        return value
    if isinstance(value, Mapping):
        return RetrievalQuery(
            kc_ids=tuple(value.get("kc_ids", value.get("kcIds", ())) or ()),
            difficulty_min=value.get("difficulty_min", value.get("difficultyMin")),
            difficulty_max=value.get("difficulty_max", value.get("difficultyMax")),
            difficulty_target=value.get("difficulty_target", value.get("difficultyTarget")),
            item_types=tuple(value.get("item_types", value.get("itemTypes", ())) or ()),
            limit=value.get("limit", 10),
        )
    raise ItemValidationError("query must be a mapping or RetrievalQuery")


@dataclass(frozen=True)
class RetrievalHit:
    """Opaque retrieval result plus annotation summary (never item content)."""

    item_id: str
    score: int
    required_kcs: tuple[str, ...]
    q_matrix_kcs: tuple[str, ...]
    difficulty: float | None
    item_type: str | None
    annotation_confidence: float | None
    review_status: str
    version: int
    estimated_minutes: float | None
    grade_level: int | None

    def __post_init__(self) -> None:
        object.__setattr__(self, "item_id", _opaque(self.item_id, "item_id"))
        object.__setattr__(self, "score", int(self.score))

    def summary(self) -> dict[str, Any]:
        return {
            "item_id": self.item_id,
            "score": self.score,
            "required_kcs": list(self.required_kcs),
            "q_matrix_kcs": list(self.q_matrix_kcs),
            "difficulty": self.difficulty,
            "item_type": self.item_type,
            "annotation_confidence": self.annotation_confidence,
            "review_status": self.review_status,
            "version": self.version,
            "estimated_minutes": self.estimated_minutes,
            "grade_level": self.grade_level,
        }


# ---------------------------------------------------------------------------
# Gate-bound retrieval plan
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RetrievalCandidate:
    """A hit that passed both the curriculum gate and prerequisite closure."""

    item_id: str
    item: CurriculumItem
    hit: RetrievalHit
    decision: GateDecision
    missing_prerequisites: tuple[str, ...] = ()
    unknown_kcs: tuple[str, ...] = ()


@dataclass(frozen=True)
class RetrievalRejection:
    """One retrieved hit that must not become a candidate."""

    item_id: str
    reasons: tuple[str, ...]


@dataclass(frozen=True)
class RetrievalPlan:
    """Fail-closed result of retrieval + gate + prerequisite closure."""

    hits: tuple[RetrievalHit, ...]
    candidates: tuple[RetrievalCandidate, ...]
    rejected: tuple[RetrievalRejection, ...]
    allowed_kcs: frozenset[str]
    blocked_reason: str | None = None


def prerequisite_diagnostics(
    graph: KnowledgeGraph,
    required_kcs: Iterable[str],
    allowed: Iterable[str],
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Return ``(missing_prerequisites, unknown_kcs)`` for a candidate.

    A required KC itself is checked by the curriculum gate; this helper checks
    the transitive prerequisite closure.  Unknown KCs are reported separately
    so callers can fail closed instead of treating them as satisfied.
    """
    allowed_set = set(allowed)
    missing: set[str] = set()
    unknown: set[str] = set()
    for kc_id in required_kcs:
        if kc_id not in graph.nodes_by_id:
            unknown.add(kc_id)
            continue
        for prerequisite in graph.prerequisite_closure(kc_id):
            if prerequisite not in allowed_set:
                missing.add(prerequisite)
    return tuple(sorted(missing)), tuple(sorted(unknown))


def plan_retrieval(
    bank: ItemBank,
    graph: KnowledgeGraph | None,
    progress: LearnerProgress | Mapping[str, Any],
    mode: str,
    query: RetrievalQuery | Mapping[str, Any] | None = None,
    *,
    min_annotation_confidence: float = DEFAULT_MIN_ANNOTATION_CONFIDENCE,
    min_progress_confidence: float = DEFAULT_MIN_PROGRESS_CONFIDENCE,
) -> RetrievalPlan:
    """Retrieve, then re-check every hit through the fail-closed gate.

    A hit becomes a candidate only when the curriculum gate allows it **and**
    every transitive prerequisite is already in the learner's allowed set.  A
    missing graph, unknown KC, missing item, or incomplete annotation is a
    rejection; there is no permissive fallback.
    """
    hits = bank.search(query)
    allowed = allowed_kcs(
        progress, mode, min_progress_confidence=min_progress_confidence
    )
    if graph is None:
        return RetrievalPlan(
            hits=hits,
            candidates=(),
            rejected=tuple(
                RetrievalRejection(item_id=hit.item_id, reasons=("graph_unavailable",))
                for hit in hits
            ),
            allowed_kcs=frozenset(allowed),
            blocked_reason="graph_unavailable",
        )

    candidates: list[RetrievalCandidate] = []
    rejected: list[RetrievalRejection] = []
    for hit in hits:
        record = bank.current(hit.item_id)
        item = record.to_curriculum_item()
        decision = allow(
            item,
            progress,
            mode,
            min_annotation_confidence=min_annotation_confidence,
            min_progress_confidence=min_progress_confidence,
        )
        missing, unknown = prerequisite_diagnostics(
            graph, item.required_kcs, decision.allowed_kcs
        )
        reasons = list(decision.reasons)
        if unknown:
            reasons.append("kc_not_in_graph:" + ",".join(unknown))
        if missing:
            reasons.append("prerequisites_not_met:" + ",".join(missing))
        if decision.allowed and not missing and not unknown:
            candidates.append(
                RetrievalCandidate(
                    item_id=hit.item_id,
                    item=item,
                    hit=hit,
                    decision=decision,
                    missing_prerequisites=missing,
                    unknown_kcs=unknown,
                )
            )
        else:
            rejected.append(
                RetrievalRejection(item_id=hit.item_id, reasons=tuple(reasons))
            )
    return RetrievalPlan(
        hits=hits,
        candidates=tuple(candidates),
        rejected=tuple(rejected),
        allowed_kcs=frozenset(allowed),
    )
