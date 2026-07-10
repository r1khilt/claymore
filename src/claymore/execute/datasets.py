"""[Bio] Resolve the datasets a lab was *talking about* into runnable numeric tables.

The "Ask" side finds attributed facts; this turns the datasets those facts mention into something an
analysis can train on. Two rules make it safe and honest:

* **Scope by construction (R10/R13, hard rule 4).** :func:`resolve_datasets` only ever sees the
  ``Fact`` list that :func:`claymore.memory.retrieval.retrieve` already visibility-filtered for the
  asking user. A dataset referenced *only* in a DM the user isn't in never appears in those facts,
  so it can never be resolved here — the scope check is not re-implemented, it is inherited.
* **Never fabricate data (hard rule 1).** If no resolved fact points at a dataset we can actually
  load, the caller must say so — it must not invent a table. Each resolved dataset carries the
  provenance of the fact that referenced it, so the answer can cite *who* mentioned it and *where*.

For the keyless demo the catalog ships a few deterministic, synthetic-but-realistic scientific
datasets (a CBX2 activity assay with real signal, a expression→viability screen, a null control with
no signal), seeded so a run is reproducible. A real deployment resolves a ``dataset:`` reference to
the file the lab actually attached; that swap is behind :func:`load_dataset` and changes nothing
downstream.
"""

from __future__ import annotations

import hashlib
import math
import random
from dataclasses import dataclass, field
from datetime import datetime

from claymore.memory.ontology import Fact

# Defensive cap: a resolved external table is untrusted in size; never train on an unbounded row
# count (cost/DoS, R6). Synthetic catalog data is far under this; a real CSV is subsampled to it.
MAX_ROWS = 5_000
MAX_FEATURES = 64


@dataclass(frozen=True)
class Dataset:
    """A loaded numeric table: named feature columns + one target column, ready for analysis.

    A plain dataclass (not pydantic) on purpose — it holds a few hundred rows of floats and is never
    serialized to the wire; only the derived, small :class:`~claymore.execute.ml_analysis.MLResult`
    is. ``target_kind`` lets the runner coerce sensibly (binarize a continuous target for
    classification; treat a binary target as 0/1 for regression/correlation).
    """

    id: str
    name: str
    description: str
    feature_names: tuple[str, ...]
    target_name: str
    target_kind: str  # "binary" | "continuous"
    rows: tuple[tuple[float, ...], ...]
    targets: tuple[float, ...]

    @property
    def n_rows(self) -> int:
        return len(self.rows)

    @property
    def n_features(self) -> int:
        return len(self.feature_names)

    def column(self, name: str) -> list[float]:
        """The values of one feature column by name (raises ``KeyError`` if it isn't a column)."""
        idx = self.feature_names.index(name)  # ValueError if absent — caller validates first
        return [row[idx] for row in self.rows]


@dataclass(frozen=True)
class ResolvedDataset:
    """A :class:`Dataset` plus the provenance of the fact that referenced it (for citation)."""

    dataset: Dataset
    source_platform: str
    source_id: str
    author: str
    timestamp: datetime
    source_label: str = ""


def _seed(dataset_id: str) -> int:
    """A stable per-dataset seed so synthetic generation (and thus every run) is reproducible."""
    return int.from_bytes(hashlib.sha256(dataset_id.encode("utf-8")).digest()[:4], "big")


def _assay_cbx2() -> Dataset:
    """A CBX2 binding-assay screen: physicochemical features → binary ``active`` with real signal.

    A latent activity propensity drives both the features and the label (with label noise), so a
    classifier recovers a genuine, well-above-chance AUC — the "hypothesis supported" demo path.
    """
    rng = random.Random(_seed("assay-cbx2"))
    rows: list[tuple[float, ...]] = []
    targets: list[float] = []
    for _ in range(260):
        s = rng.gauss(0.0, 1.0)  # latent propensity to bind
        logp = 2.5 + 1.1 * s + rng.gauss(0.0, 0.5)
        mw = 360.0 + 48.0 * s + rng.gauss(0.0, 26.0)
        hbd = float(max(0, round(3 - 0.9 * s + rng.gauss(0.0, 0.8))))
        tpsa = 90.0 - 15.0 * s + rng.gauss(0.0, 12.0)
        rings = float(max(1, round(3 + 0.6 * s + rng.gauss(0.0, 0.7))))
        p = 1.0 / (1.0 + math.exp(-2.2 * s))  # signal → label (steeper → less label noise)
        y = 1.0 if rng.random() < p else 0.0
        rows.append((logp, mw, hbd, tpsa, rings))
        targets.append(y)
    return Dataset(
        id="assay-cbx2",
        name="CBX2 binding assay",
        description="260 compounds · physicochemical descriptors → binding activity",
        feature_names=("logP", "mol_weight", "h_donors", "tpsa", "aromatic_rings"),
        target_name="active",
        target_kind="binary",
        rows=tuple(rows),
        targets=tuple(targets),
    )


def _expression_screen() -> Dataset:
    """An expression→viability screen: three gene readouts + dose → continuous viability score.

    A latent factor plus a real dose effect drive the target, so a linear model explains a solid
    fraction of variance — the "regression supported" demo path.
    """
    rng = random.Random(_seed("expression-screen"))
    rows: list[tuple[float, ...]] = []
    targets: list[float] = []
    for _ in range(220):
        s = rng.gauss(0.0, 1.0)
        dose = rng.uniform(0.0, 10.0)
        brd4 = 6.0 + 1.1 * s + rng.gauss(0.0, 0.5)
        ezh2 = 5.0 - 0.7 * s + rng.gauss(0.0, 0.5)
        myc = 7.0 + 0.9 * s + rng.gauss(0.0, 0.6)
        viability = 60.0 + 16.0 * s - 3.2 * dose + rng.gauss(0.0, 6.0)
        rows.append((brd4, ezh2, myc, dose))
        targets.append(viability)
    return Dataset(
        id="expression-screen",
        name="Expression → viability screen",
        description="220 wells · gene expression + dose → cell viability",
        feature_names=("BRD4", "EZH2", "MYC", "dose_uM"),
        target_name="viability",
        target_kind="continuous",
        rows=tuple(rows),
        targets=tuple(targets),
    )


def _null_control() -> Dataset:
    """A negative control: features and target are independent draws — no signal to find.

    The "hypothesis refuted" demo path. A model on this lands at ~chance AUC / ~zero R² / ~zero
    correlation, and the verdict logic reports *refuted* honestly rather than inventing a finding.
    """
    rng = random.Random(_seed("null-control"))
    rows: list[tuple[float, ...]] = []
    targets: list[float] = []
    for _ in range(200):
        rows.append((rng.gauss(0.0, 1.0), rng.gauss(0.0, 1.0), rng.gauss(0.0, 1.0)))
        targets.append(rng.gauss(0.0, 1.0))  # independent of the features
    return Dataset(
        id="null-control",
        name="Randomized control",
        description="200 rows · shuffled features vs. target — a no-signal negative control",
        feature_names=("signal_a", "signal_b", "signal_c"),
        target_name="response",
        target_kind="continuous",
        rows=tuple(rows),
        targets=tuple(targets),
    )


@dataclass(frozen=True)
class _CatalogEntry:
    build: object  # () -> Dataset
    aliases: tuple[str, ...] = field(default_factory=tuple)


# Keyed by dataset id; aliases are the keywords that might appear in a memory fact referencing it.
_CATALOG: dict[str, _CatalogEntry] = {
    "assay-cbx2": _CatalogEntry(_assay_cbx2, ("cbx2", "assay", "binding", "activity", "compound")),
    "expression-screen": _CatalogEntry(
        _expression_screen, ("expression", "viability", "screen", "dose", "rna")
    ),
    "null-control": _CatalogEntry(_null_control, ("control", "randomized", "negative", "null")),
}

# Built datasets are cached so repeated resolution in one turn doesn't regenerate the rows.
_LOADED: dict[str, Dataset] = {}


def load_dataset(dataset_id: str) -> Dataset | None:
    """Load a catalog dataset by id (cached), or ``None`` if the id isn't in the catalog.

    The single seam a real deployment swaps: instead of a synthetic generator, resolve
    ``dataset_id`` to the file the lab actually attached and parse it into a :class:`Dataset`.
    """
    if dataset_id not in _CATALOG:
        return None
    if dataset_id not in _LOADED:
        built = _CATALOG[dataset_id].build
        _LOADED[dataset_id] = built()  # type: ignore[operator]
    return _LOADED[dataset_id]


def _match_ids(fact: Fact) -> list[str]:
    """Catalog ids a single fact references — a strong ``dataset:<id>``/id hit in the object id, or
    a softer alias hit in the fact's statement text. Everything is matched case-folded as data."""
    object_id = fact.object_id.casefold()
    statement = fact.statement.casefold()
    matched: list[str] = []
    for dataset_id, entry in _CATALOG.items():
        folded = dataset_id.casefold()
        strong = folded in object_id or f"dataset:{folded}" in statement
        soft = any(alias in statement or alias in object_id for alias in entry.aliases)
        if strong or soft:
            matched.append(dataset_id)
    return matched


def resolve_datasets(facts: list[Fact]) -> list[ResolvedDataset]:
    """The datasets referenced by an already-scoped fact list, each with citation provenance.

    Deduped by dataset id, keeping the first (most relevant/recent — ``facts`` arrives ranked)
    referencing fact so the citation points at a real source. Because ``facts`` is the visibility-
    filtered output of :func:`retrieve`, this inherits the tenant + need-to-know boundary and never
    surfaces a dataset the asking user may not see (R10/R13).
    """
    resolved: dict[str, ResolvedDataset] = {}
    for fact in facts:
        for dataset_id in _match_ids(fact):
            if dataset_id in resolved:
                continue
            dataset = load_dataset(dataset_id)
            if dataset is None:  # referenced but not loadable — never fabricate (hard rule 1)
                continue
            prov = fact.provenance
            resolved[dataset_id] = ResolvedDataset(
                dataset=dataset,
                source_platform=prov.source_platform.value,
                source_id=prov.source_id,
                author=prov.author,
                timestamp=prov.timestamp,
                source_label=fact.visibility.source_label,
            )
    return list(resolved.values())
