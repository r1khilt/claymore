"""The scientific ontology — the moat (CLAUDE.md §6, BUILD_PLAN.md §5).

Entity + fact-edge *types* that extend Graphiti's extraction, plus the ``Provenance`` and
``Fact`` shapes every edge carries. This is a frozen contract: the extraction pass (Brain)
writes these, retrieval reads them, and the whole "who said X, when, and is it still true"
value prop lives on getting it right. Two-person decision to change.
"""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from claymore.domain import UNKNOWN_AUTHOR, PersonId, SourcePlatform, Visibility


class EntityType(StrEnum):
    """Graph node types. Base lab entities + the domain (bio) entities that are Claymore's."""

    # base
    PERSON = "Person"
    MEETING = "Meeting"
    MESSAGE = "Message"
    DOCUMENT = "Document"
    CODE_COMMIT = "CodeCommit"
    DATASET = "Dataset"
    INSTRUMENT = "Instrument"
    REAGENT = "Reagent"
    PROTOCOL = "Protocol"
    HYPOTHESIS = "Hypothesis"
    EXPERIMENT = "Experiment"
    RESULT = "Result"
    FIGURE = "Figure"
    # domain (bio)
    GENE = "Gene"
    PROTEIN = "Protein"
    CELL_LINE = "CellLine"
    ASSAY = "Assay"
    COMPOUND = "Compound"


class EdgeType(StrEnum):
    """Bi-temporal, provenance-bearing fact-edge types.

    ``CONTRADICTS`` and ``SUPERSEDES`` are NOT produced by single-episode extraction — the
    reconciliation pass (``memory/reconcile.py``, R12) writes them by comparing a new fact
    against existing ones.
    """

    SUGGESTED = "SUGGESTED"
    DECIDED = "DECIDED"
    RAN = "RAN"
    PRODUCED = "PRODUCED"
    CONTRADICTS = "CONTRADICTS"
    SUPERSEDES = "SUPERSEDES"
    MENTIONS = "MENTIONS"
    AUTHORED_BY = "AUTHORED_BY"
    DERIVED_FROM = "DERIVED_FROM"
    USES = "USES"


# Edges written only by the reconciliation pass, never by per-episode extraction (R12).
RECONCILED_EDGES: frozenset[EdgeType] = frozenset({EdgeType.CONTRADICTS, EdgeType.SUPERSEDES})


class Provenance(BaseModel):
    """Where a fact came from — attached to every edge (CLAUDE.md §6). No source → no assert."""

    model_config = ConfigDict(frozen=True)

    source_platform: SourcePlatform
    source_id: str
    timestamp: datetime
    author: PersonId = UNKNOWN_AUTHOR
    confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    """Model/heuristic confidence that the fact is what the source says."""

    extraction_confidence: float = Field(default=1.0, ge=0.0, le=1.0)
    """Confidence from the cheap extraction model; retrieval may threshold on it (R12)."""


class Fact(BaseModel):
    """A bi-temporal, provenance- and visibility-bearing edge between two entities."""

    model_config = ConfigDict(frozen=True)

    subject_id: str
    edge: EdgeType
    object_id: str

    valid_from: datetime
    valid_to: datetime | None = None
    """``None`` = still valid. Set when a later fact supersedes this one (R12)."""

    provenance: Provenance
    visibility: Visibility
    """Inherited from the contributing episode(s); most-restrictive when reinforced (R13)."""
