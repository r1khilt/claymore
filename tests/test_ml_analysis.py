"""Tests for the ML-analysis runner + dataset resolver (execute/ml_analysis.py, datasets.py).

The verdict is a pure function of the metrics, so we assert its *direction* on datasets with known
signal (a planted-signal assay → supported; a null control → refuted), plus that the pipeline is
deterministic and yields well-formed, attributed, charted output.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from claymore.execute.datasets import ResolvedDataset, load_dataset, resolve_datasets
from claymore.execute.ml_analysis import InvalidColumn, MLRecipe, Verdict, run_analysis
from claymore.memory.graph import InMemoryMemoryStore
from tests.fixtures import LAB_WIDE, make_episode


def _resolved(dataset_id: str) -> ResolvedDataset:
    dataset = load_dataset(dataset_id)
    assert dataset is not None
    return ResolvedDataset(
        dataset=dataset,
        source_platform="slack",
        source_id="C1",
        author="p_lucas",
        timestamp=datetime(2026, 3, 3, tzinfo=UTC),
        source_label="#protein-eng",
    )


# --- verdict direction on known-signal datasets -----------------------------------------------


def test_classification_supported_on_signal() -> None:
    r = run_analysis(_resolved("assay-cbx2"), MLRecipe.CLASSIFICATION, hypothesis="H")
    assert r.verdict == Verdict.SUPPORTED
    assert float(dict(r.metrics)["test AUC"]) >= 0.70


def test_classification_refuted_on_null() -> None:
    r = run_analysis(_resolved("null-control"), MLRecipe.CLASSIFICATION, hypothesis="H")
    assert r.verdict == Verdict.REFUTED


def test_regression_supported_on_signal() -> None:
    r = run_analysis(_resolved("expression-screen"), MLRecipe.REGRESSION, hypothesis="H")
    assert r.verdict == Verdict.SUPPORTED


def test_regression_refuted_on_null() -> None:
    r = run_analysis(_resolved("null-control"), MLRecipe.REGRESSION, hypothesis="H")
    assert r.verdict == Verdict.REFUTED


def test_correlation_supported_on_signal() -> None:
    r = run_analysis(_resolved("expression-screen"), MLRecipe.CORRELATION, hypothesis="H")
    assert r.verdict == Verdict.SUPPORTED
    assert float(dict(r.metrics)["p-value"]) < 0.05


def test_correlation_refuted_on_null() -> None:
    r = run_analysis(_resolved("null-control"), MLRecipe.CORRELATION, hypothesis="H")
    assert r.verdict == Verdict.REFUTED


# --- output shape / attribution / determinism -------------------------------------------------


def test_result_is_attributed_and_charted() -> None:
    r = run_analysis(
        _resolved("assay-cbx2"), MLRecipe.CLASSIFICATION, hypothesis="Descriptors predict activity"
    )
    assert r.dataset_author == "p_lucas"  # provenance, never fabricated (hard rule 1)
    assert r.dataset_source == "#protein-eng"
    assert r.hypothesis == "Descriptors predict activity"
    assert r.charts
    assert all(c.svg.startswith("<svg") and c.svg.rstrip().endswith("</svg>") for c in r.charts)
    assert r.metrics


def test_deterministic() -> None:
    a = run_analysis(_resolved("assay-cbx2"), MLRecipe.CLASSIFICATION, hypothesis="H")
    b = run_analysis(_resolved("assay-cbx2"), MLRecipe.CLASSIFICATION, hypothesis="H")
    assert a.model_dump() == b.model_dump()


def test_every_recipe_on_every_dataset_is_valid() -> None:
    for dataset_id in ("assay-cbx2", "expression-screen", "null-control"):
        for recipe in MLRecipe:
            r = run_analysis(_resolved(dataset_id), recipe, hypothesis="H")
            assert r.verdict in {v.value for v in Verdict}
            assert r.rationale


# --- feature selection ------------------------------------------------------------------------


def test_single_feature_restriction() -> None:
    r = run_analysis(
        _resolved("expression-screen"), MLRecipe.CORRELATION, hypothesis="H", feature="dose_uM"
    )
    assert dict(r.metrics)["feature"] == "dose_uM"


def test_invalid_feature_raises_listing_columns() -> None:
    with pytest.raises(InvalidColumn) as exc:
        run_analysis(_resolved("assay-cbx2"), MLRecipe.CORRELATION, hypothesis="H", feature="nope")
    assert "logP" in str(exc.value)


# --- resolver: matches a referenced dataset, dedupes, carries provenance -----------------------


async def test_resolver_finds_dataset_from_facts() -> None:
    store = InMemoryMemoryStore()
    await store.add_episode(
        make_episode(
            source_id="m1",
            author="p_lucas",
            visibility=LAB_WIDE,
            text="Shared the CBX2 assay data",
            refs=("dataset:assay-cbx2",),
        )
    )
    facts = await store.search("lab1", "cbx2 assay", group_ids=["lab1"], limit=10)
    resolved = resolve_datasets(facts)
    assert [r.dataset.id for r in resolved] == ["assay-cbx2"]
    assert resolved[0].author == "p_lucas"


def test_resolver_empty_when_nothing_referenced() -> None:
    assert resolve_datasets([]) == []
