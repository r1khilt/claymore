"""[Bio] The ML-analysis runner: train a model on a lab dataset and judge a hypothesis.

This is the "expand a retrieved idea into a runnable task and run it" path (CLAUDE.md §1.7),
scoped to data-driven ML: take a dataset the lab was talking about, fit a real model, and return a
grounded *verdict* on the hypothesis plus visualizations that explain it.

Two design rules keep it correct and safe:

* **The verdict is a pure function of the computed metrics, never an opinion.** Each recipe has an
  explicit, documented threshold (classification: held-out AUC; regression: test R²; correlation:
  a permutation-test p-value with an effect-size floor). "Supported / refuted / inconclusive" falls
  out of the numbers — so the agent cannot talk itself into a finding the data doesn't support
  (hard rule 1). Small/degenerate samples resolve to *inconclusive*, never a confident claim.
* **Trusted code over untrusted data (hard rule 3/7).** The model never emits code to run; the
  agent only *chooses a recipe and parameters*, and this module's own (first-party) numeric routines
  execute over the dataset's numbers. Dataset content is treated strictly as data — a malicious
  string in a cell is a number-parse failure at worst, never an instruction. There is no secret and
  no network in this path, so the lethal-trifecta risk is closed by construction, not by a sandbox.
  The heavy/accelerated path (torch on Modal, behind the approval gate) slots in behind the same
  contract; the shipped default is stdlib-only so it runs everywhere, offline, deterministically.

The classifier is a genuine 2-layer neural net trained by backprop (pure-Python; a torch backend is
used automatically when the ``execute`` extra is installed). Determinism is load-bearing: the same
(dataset, recipe, params, seed) always yields the same verdict, which the adversarial suite asserts.
"""

from __future__ import annotations

import math
import random
from dataclasses import replace
from enum import StrEnum

from pydantic import BaseModel

from claymore.execute.charts import line_chart, roc_chart, scatter_chart
from claymore.execute.datasets import MAX_FEATURES, MAX_ROWS, Dataset, ResolvedDataset, _seed

# --- tunables (thresholds are the verdict policy; documented + tested) ------------------------

MIN_SAMPLES = 24  # below this a dataset is too small to conclude anything → inconclusive
MIN_TEST = 8  # below this many held-out rows, likewise inconclusive
_TEST_FRACTION = 0.25
_HIDDEN = 8
_EPOCHS = 140
_LR = 0.4
_PERMUTATIONS = 500

# Verdict cutoffs, per recipe. Between the two bounds is honest "inconclusive".
_AUC_SUPPORT = 0.70
_AUC_REFUTE = 0.55
_R2_SUPPORT = 0.50
_R2_REFUTE = 0.10
_CORR_P = 0.05
_CORR_EFFECT = 0.30


class MLRecipe(StrEnum):
    """The fixed set of analyses the agent may choose from — a strict enum, not free-form code."""

    CLASSIFICATION = "classification"
    REGRESSION = "regression"
    CORRELATION = "correlation"


class Verdict(StrEnum):
    """The grounded conclusion about the hypothesis — derived only from the metrics."""

    SUPPORTED = "supported"
    REFUTED = "refuted"
    INCONCLUSIVE = "inconclusive"


class Chart(BaseModel):
    """One self-contained SVG visualization (built by ``execute.charts``, escaped, no deps)."""

    kind: str  # "loss" | "roc" | "scatter" | "fit"
    title: str
    svg: str


class MLResult(BaseModel):
    """The full analysis outcome — a verdict, the numbers behind it, provenance, and charts.

    Everything the Composer card needs. ``dataset_*`` carry the attribution of the fact that
    referenced the dataset (hard rule 1); ``metrics`` are ``(label, value)`` pairs the card renders
    in a grid; ``charts`` are inline SVG.
    """

    title: str
    hypothesis: str
    recipe: str
    verdict: str
    rationale: str
    dataset_name: str
    dataset_source: str
    dataset_author: str
    n_rows: int
    n_features: int
    model_kind: str
    metrics: list[tuple[str, str]]
    charts: list[Chart]


class InvalidColumn(ValueError):
    """Raised when the agent names a feature/target column the dataset doesn't have.

    Carries the available columns so the caller can hand the model a corrective message and let it
    retry — the strict-parameter posture that bounds what a tool call can smuggle (SECURITY.md §3a).
    """


def _prepare(dataset: Dataset) -> Dataset:
    """Bound + sanitize an incoming table before any training touches it (adversarial input, R6).

    Two defenses, applied to *every* dataset including a real external one: cap the row/feature
    count so an unbounded table can't be a DoS, and coerce any non-finite value (a NaN or ±inf that
    slipped through a malformed source) to 0.0 so it can never poison a metric or leak ``nan`` into
    a verdict. Returns the same object unchanged when nothing needed fixing.
    """
    names = dataset.feature_names[:MAX_FEATURES]
    keep = len(names)
    rows = tuple(
        tuple(v if math.isfinite(v) else 0.0 for v in row[:keep]) for row in dataset.rows[:MAX_ROWS]
    )
    targets = tuple(v if math.isfinite(v) else 0.0 for v in dataset.targets[:MAX_ROWS])
    if names == dataset.feature_names and rows == dataset.rows and targets == dataset.targets:
        return dataset
    return replace(dataset, feature_names=names, rows=rows, targets=targets)


# --- public entry point -----------------------------------------------------------------------


def run_analysis(
    resolved: ResolvedDataset,
    recipe: MLRecipe,
    *,
    hypothesis: str,
    feature: str | None = None,
    seed: int = 0,
) -> MLResult:
    """Run one analysis and return a grounded :class:`MLResult`.

    ``feature`` (optional) selects the single predictor for correlation, or restricts a
    classification/regression model to one column; ``None`` uses all columns (and, for correlation,
    auto-selects the most-associated one). An unknown ``feature`` raises :class:`InvalidColumn`.
    ``seed`` is XORed with a per-dataset seed so runs are reproducible yet vary across datasets.
    """
    dataset = _prepare(resolved.dataset)
    resolved = replace(resolved, dataset=dataset)
    if feature is not None and feature not in dataset.feature_names:
        raise InvalidColumn(
            f"'{feature}' is not a column of {dataset.name}; "
            f"available: {', '.join(dataset.feature_names)}"
        )
    rng = random.Random(seed ^ _seed(dataset.id))
    if dataset.n_rows < MIN_SAMPLES:
        return _degenerate(resolved, recipe, hypothesis, f"only {dataset.n_rows} rows")
    if recipe is MLRecipe.CLASSIFICATION:
        return _classify(resolved, hypothesis, feature, rng)
    if recipe is MLRecipe.REGRESSION:
        return _regress(resolved, hypothesis, feature, rng)
    return _correlate(resolved, hypothesis, feature, rng)


# --- classification: a real 2-layer net, judged on held-out AUC -------------------------------


def _classify(
    resolved: ResolvedDataset, hypothesis: str, feature: str | None, rng: random.Random
) -> MLResult:
    dataset = resolved.dataset
    x_cols = [feature] if feature else list(dataset.feature_names)
    x_all = _select(dataset, x_cols)
    y_all = _as_binary(dataset.targets)
    (x_tr, y_tr), (x_te, y_te) = _split(x_all, y_all, rng)
    x_tr, x_te = _standardize(x_tr, x_te)

    n_pos = sum(1 for v in y_te if v >= 0.5)
    n_neg = len(y_te) - n_pos
    if len(y_te) < MIN_TEST or n_pos == 0 or n_neg == 0:
        return _degenerate(resolved, MLRecipe.CLASSIFICATION, hypothesis, "too few / single-class")

    scores, loss_history, model_kind = _train_classifier(x_tr, y_tr, x_te, rng)
    auc = _auc(scores, y_te)
    acc = _accuracy(scores, y_te)
    baseline = max(n_pos, n_neg) / len(y_te)
    fpr, tpr = _roc_points(scores, y_te)

    if auc >= _AUC_SUPPORT:
        verdict = Verdict.SUPPORTED
    elif auc <= _AUC_REFUTE:
        verdict = Verdict.REFUTED
    else:
        verdict = Verdict.INCONCLUSIVE
    rationale = (
        f"Held-out AUC {auc:.2f} on {len(y_te)} samples "
        f"({'≥' if auc >= _AUC_SUPPORT else 'below'} the {_AUC_SUPPORT:.2f} support threshold); "
        f"accuracy {acc:.0%} vs a {baseline:.0%} majority-class baseline."
    )
    return _result(
        resolved,
        MLRecipe.CLASSIFICATION,
        hypothesis,
        verdict,
        rationale,
        model_kind,
        metrics=[
            ("test AUC", f"{auc:.2f}"),
            ("accuracy", f"{acc:.0%}"),
            ("baseline", f"{baseline:.0%}"),
            ("train / test", f"{len(y_tr)} / {len(y_te)}"),
        ],
        charts=[
            Chart(
                kind="loss",
                title="Training loss",
                svg=line_chart(loss_history, x_label="epoch", y_label="BCE loss"),
            ),
            Chart(kind="roc", title="ROC curve", svg=roc_chart(fpr, tpr, auc=auc)),
        ],
    )


def _train_classifier(
    x_tr: list[list[float]],
    y_tr: list[float],
    x_te: list[list[float]],
    rng: random.Random,
) -> tuple[list[float], list[float], str]:
    """Train the classifier, returning (test probabilities, per-epoch loss, model label).

    Prefers a torch MLP when the ``execute`` extra is installed (the literal "PyTorch model"), and
    falls back to an equivalent pure-Python backprop net so the default path needs no dependency and
    stays deterministic. Both return the same shapes behind one contract."""
    try:
        return _train_classifier_torch(x_tr, y_tr, x_te)
    except Exception:
        # No torch (or it errored) — the stdlib net is the tested, deterministic default.
        return _train_classifier_py(x_tr, y_tr, x_te, rng)


def _train_classifier_py(
    x_tr: list[list[float]],
    y_tr: list[float],
    x_te: list[list[float]],
    rng: random.Random,
) -> tuple[list[float], list[float], str]:
    """Full-batch backprop for a d→h(tanh)→1(sigmoid) net. Deterministic given ``rng``."""
    d = len(x_tr[0])
    h = _HIDDEN
    w1 = [[rng.gauss(0.0, 1.0 / math.sqrt(d)) for _ in range(d)] for _ in range(h)]
    b1 = [0.0] * h
    w2 = [rng.gauss(0.0, 1.0 / math.sqrt(h)) for _ in range(h)]
    b2 = 0.0
    n = len(x_tr)
    loss_history: list[float] = []

    for _ in range(_EPOCHS):
        gw1 = [[0.0] * d for _ in range(h)]
        gb1 = [0.0] * h
        gw2 = [0.0] * h
        gb2 = 0.0
        loss = 0.0
        for x, y in zip(x_tr, y_tr, strict=True):
            a1 = [math.tanh(sum(w1[j][k] * x[k] for k in range(d)) + b1[j]) for j in range(h)]
            p = _sigmoid(sum(w2[j] * a1[j] for j in range(h)) + b2)
            loss += _bce(p, y)
            dz2 = p - y
            for j in range(h):
                gw2[j] += dz2 * a1[j]
                dz1 = dz2 * w2[j] * (1.0 - a1[j] * a1[j])
                gb1[j] += dz1
                for k in range(d):
                    gw1[j][k] += dz1 * x[k]
            gb2 += dz2
        scale = _LR / n
        for j in range(h):
            w2[j] -= scale * gw2[j]
            b1[j] -= scale * gb1[j]
            for k in range(d):
                w1[j][k] -= scale * gw1[j][k]
        b2 -= scale * gb2
        loss_history.append(loss / n)

    def predict(x: list[float]) -> float:
        a1 = [math.tanh(sum(w1[j][k] * x[k] for k in range(d)) + b1[j]) for j in range(h)]
        return _sigmoid(sum(w2[j] * a1[j] for j in range(h)) + b2)

    return [predict(x) for x in x_te], loss_history, "2-layer neural net (pure-Python backprop)"


def _train_classifier_torch(
    x_tr: list[list[float]],
    y_tr: list[float],
    x_te: list[list[float]],
) -> tuple[list[float], list[float], str]:
    """A torch MLP mirroring the pure-Python net — used when the ``execute`` extra is present.

    Kept behind the same return contract; covered by a torch-gated test (skipped when absent), while
    the pure-Python path is the always-tested default.
    """
    import torch  # optional (execute extra); ImportError is caught by the caller's fallback

    torch.manual_seed(0)
    xt = torch.tensor(x_tr, dtype=torch.float32)
    yt = torch.tensor(y_tr, dtype=torch.float32).unsqueeze(1)
    net = torch.nn.Sequential(
        torch.nn.Linear(len(x_tr[0]), _HIDDEN), torch.nn.Tanh(), torch.nn.Linear(_HIDDEN, 1)
    )
    opt = torch.optim.Adam(net.parameters(), lr=0.05)
    loss_fn = torch.nn.BCEWithLogitsLoss()
    loss_history: list[float] = []
    for _ in range(_EPOCHS):
        opt.zero_grad()
        loss = loss_fn(net(xt), yt)
        loss.backward()
        opt.step()
        loss_history.append(float(loss.item()))
    with torch.no_grad():
        scores = torch.sigmoid(net(torch.tensor(x_te, dtype=torch.float32))).squeeze(1).tolist()
    return list(scores), loss_history, "PyTorch MLP"


# --- regression: gradient-descent linear model, judged on held-out R² -------------------------


def _regress(
    resolved: ResolvedDataset, hypothesis: str, feature: str | None, rng: random.Random
) -> MLResult:
    dataset = resolved.dataset
    x_cols = [feature] if feature else list(dataset.feature_names)
    x_all = _select(dataset, x_cols)
    y_all = list(dataset.targets)
    (x_tr, y_tr), (x_te, y_te) = _split(x_all, y_all, rng)
    x_tr, x_te = _standardize(x_tr, x_te)
    if len(y_te) < MIN_TEST:
        return _degenerate(resolved, MLRecipe.REGRESSION, hypothesis, "too few held-out rows")

    weights, bias = _train_linear(x_tr, y_tr)
    preds = [sum(w * v for w, v in zip(weights, x, strict=True)) + bias for x in x_te]
    r2 = _r2(preds, y_te)
    rmse = math.sqrt(sum((p - t) ** 2 for p, t in zip(preds, y_te, strict=True)) / len(y_te))

    if r2 >= _R2_SUPPORT:
        verdict = Verdict.SUPPORTED
    elif r2 <= _R2_REFUTE:
        verdict = Verdict.REFUTED
    else:
        verdict = Verdict.INCONCLUSIVE
    rationale = (
        f"The model explains R²={r2:.2f} of held-out variance in {dataset.target_name} "
        f"({'≥' if r2 >= _R2_SUPPORT else 'below'} the {_R2_SUPPORT:.2f} support threshold), "
        f"RMSE {rmse:.2f} over {len(y_te)} samples."
    )
    return _result(
        resolved,
        MLRecipe.REGRESSION,
        hypothesis,
        verdict,
        rationale,
        "linear regression (gradient descent)",
        metrics=[
            ("test R²", f"{r2:.2f}"),
            ("RMSE", f"{rmse:.2f}"),
            ("features", str(len(x_cols))),
            ("train / test", f"{len(y_tr)} / {len(y_te)}"),
        ],
        charts=[
            Chart(
                kind="fit",
                title="Predicted vs. actual",
                svg=scatter_chart(
                    y_te,
                    preds,
                    x_label=f"actual {dataset.target_name}",
                    y_label="predicted",
                    diagonal=True,
                ),
            )
        ],
    )


def _train_linear(x_tr: list[list[float]], y_tr: list[float]) -> tuple[list[float], float]:
    """Multivariate linear regression by full-batch gradient descent (standardized inputs)."""
    d = len(x_tr[0])
    weights = [0.0] * d
    bias = 0.0
    n = len(x_tr)
    for _ in range(_EPOCHS * 2):
        gw = [0.0] * d
        gb = 0.0
        for x, y in zip(x_tr, y_tr, strict=True):
            err = sum(weights[k] * x[k] for k in range(d)) + bias - y
            for k in range(d):
                gw[k] += err * x[k]
            gb += err
        scale = _LR / n
        for k in range(d):
            weights[k] -= scale * gw[k]
        bias -= scale * gb
    return weights, bias


# --- correlation: Pearson r + a permutation-test p-value --------------------------------------


def _correlate(
    resolved: ResolvedDataset, hypothesis: str, feature: str | None, rng: random.Random
) -> MLResult:
    dataset = resolved.dataset
    y = list(dataset.targets)
    if feature is not None:
        chosen = feature
    else:  # auto-select the most-associated column so the card shows the strongest relationship
        chosen = max(dataset.feature_names, key=lambda c: abs(_pearson(dataset.column(c), y)))
    x = dataset.column(chosen)

    r = _pearson(x, y)
    p = _permutation_p(x, y, r, rng)
    if p < _CORR_P and abs(r) >= _CORR_EFFECT:
        verdict = Verdict.SUPPORTED
    elif p >= _CORR_P:
        verdict = Verdict.REFUTED
    else:
        verdict = Verdict.INCONCLUSIVE
    rationale = (
        f"Pearson r={r:+.2f} between {chosen} and {dataset.target_name} "
        f"(permutation p={p:.3f}); "
        + (
            "significant with a meaningful effect size."
            if verdict is Verdict.SUPPORTED
            else "no significant association."
            if verdict is Verdict.REFUTED
            else "significant but the effect size is small."
        )
    )
    slope, intercept = _ols_line(x, y)
    return _result(
        resolved,
        MLRecipe.CORRELATION,
        hypothesis,
        verdict,
        rationale,
        "Pearson correlation + permutation test",
        metrics=[
            ("Pearson r", f"{r:+.2f}"),
            ("p-value", f"{p:.3f}"),
            ("feature", chosen),
            ("n", str(len(x))),
        ],
        charts=[
            Chart(
                kind="scatter",
                title=f"{chosen} vs. {dataset.target_name}",
                svg=scatter_chart(
                    x, y, x_label=chosen, y_label=dataset.target_name, fit=(slope, intercept)
                ),
            )
        ],
    )


# --- numeric helpers --------------------------------------------------------------------------


def _select(dataset: Dataset, columns: list[str]) -> list[list[float]]:
    """Project the dataset rows onto the given feature columns (order preserved)."""
    idx = [dataset.feature_names.index(c) for c in columns]
    return [[row[i] for i in idx] for row in dataset.rows]


def _as_binary(targets: tuple[float, ...]) -> list[float]:
    """Coerce a target to 0/1 for classification — a continuous target is split at its median."""
    distinct = set(targets)
    if distinct <= {0.0, 1.0}:
        return list(targets)
    ordered = sorted(targets)
    median = ordered[len(ordered) // 2]
    return [1.0 if v > median else 0.0 for v in targets]


def _split(
    x: list[list[float]], y: list[float], rng: random.Random
) -> tuple[tuple[list[list[float]], list[float]], tuple[list[list[float]], list[float]]]:
    """Deterministic shuffled train/test split (25% held out)."""
    order = list(range(len(x)))
    rng.shuffle(order)
    cut = max(1, int(len(order) * (1.0 - _TEST_FRACTION)))
    tr, te = order[:cut], order[cut:]
    return ([x[i] for i in tr], [y[i] for i in tr]), ([x[i] for i in te], [y[i] for i in te])


def _standardize(
    x_tr: list[list[float]], x_te: list[list[float]]
) -> tuple[list[list[float]], list[list[float]]]:
    """Z-score every feature using *train* statistics only (no test leakage). Zero-variance -> 1."""
    d = len(x_tr[0])
    means = [sum(row[k] for row in x_tr) / len(x_tr) for k in range(d)]
    stds: list[float] = []
    for k in range(d):
        var = sum((row[k] - means[k]) ** 2 for row in x_tr) / len(x_tr)
        stds.append(math.sqrt(var) or 1.0)

    def norm(rows: list[list[float]]) -> list[list[float]]:
        return [[(row[k] - means[k]) / stds[k] for k in range(d)] for row in rows]

    return norm(x_tr), norm(x_te)


def _sigmoid(z: float) -> float:
    z = max(-30.0, min(30.0, z))  # clamp so exp never overflows
    return 1.0 / (1.0 + math.exp(-z))


def _bce(p: float, y: float) -> float:
    eps = 1e-9
    p = min(1.0 - eps, max(eps, p))
    return -(y * math.log(p) + (1.0 - y) * math.log(1.0 - p))


def _auc(scores: list[float], labels: list[float]) -> float:
    """Rank-based AUC = P(score(pos) > score(neg)), ties counted as 0.5."""
    pos = [s for s, y in zip(scores, labels, strict=True) if y >= 0.5]
    neg = [s for s, y in zip(scores, labels, strict=True) if y < 0.5]
    if not pos or not neg:
        return 0.5
    wins = 0.0
    for sp in pos:
        for sn in neg:
            wins += 1.0 if sp > sn else 0.5 if sp == sn else 0.0
    return wins / (len(pos) * len(neg))


def _accuracy(scores: list[float], labels: list[float]) -> float:
    correct = sum(1 for s, y in zip(scores, labels, strict=True) if (s >= 0.5) == (y >= 0.5))
    return correct / len(labels)


def _roc_points(scores: list[float], labels: list[float]) -> tuple[list[float], list[float]]:
    """(fpr, tpr) points sweeping the decision threshold high→low, anchored at (0,0) and (1,1)."""
    pos = sum(1 for y in labels if y >= 0.5)
    neg = len(labels) - pos
    if pos == 0 or neg == 0:
        return [0.0, 1.0], [0.0, 1.0]
    thresholds = sorted({s for s in scores}, reverse=True)
    fpr = [0.0]
    tpr = [0.0]
    for thr in thresholds:
        tp = sum(1 for s, y in zip(scores, labels, strict=True) if s >= thr and y >= 0.5)
        fp = sum(1 for s, y in zip(scores, labels, strict=True) if s >= thr and y < 0.5)
        fpr.append(fp / neg)
        tpr.append(tp / pos)
    fpr.append(1.0)
    tpr.append(1.0)
    return fpr, tpr


def _r2(preds: list[float], actual: list[float]) -> float:
    mean = sum(actual) / len(actual)
    ss_tot = sum((a - mean) ** 2 for a in actual)
    ss_res = sum((p - a) ** 2 for p, a in zip(preds, actual, strict=True))
    if ss_tot == 0.0:
        return 0.0
    return 1.0 - ss_res / ss_tot


def _pearson(x: list[float], y: list[float]) -> float:
    n = len(x)
    if n == 0:
        return 0.0
    mx = sum(x) / n
    my = sum(y) / n
    cov = sum((a - mx) * (b - my) for a, b in zip(x, y, strict=True))
    sx = math.sqrt(sum((a - mx) ** 2 for a in x))
    sy = math.sqrt(sum((b - my) ** 2 for b in y))
    if sx == 0.0 or sy == 0.0:  # a constant column has no defined correlation → 0
        return 0.0
    return cov / (sx * sy)


def _permutation_p(x: list[float], y: list[float], observed: float, rng: random.Random) -> float:
    """Two-sided permutation p: fraction of label shuffles with |r| ≥ |observed| (+1 smoothing)."""
    target = abs(observed)
    shuffled = list(y)
    extreme = 0
    for _ in range(_PERMUTATIONS):
        rng.shuffle(shuffled)
        if abs(_pearson(x, shuffled)) >= target:
            extreme += 1
    return (1 + extreme) / (_PERMUTATIONS + 1)


def _ols_line(x: list[float], y: list[float]) -> tuple[float, float]:
    """Ordinary-least-squares slope/intercept for the correlation scatter's fit line."""
    n = len(x)
    mx = sum(x) / n
    my = sum(y) / n
    denom = sum((a - mx) ** 2 for a in x)
    if denom == 0.0:
        return 0.0, my
    slope = sum((a - mx) * (b - my) for a, b in zip(x, y, strict=True)) / denom
    return slope, my - slope * mx


# --- result assembly --------------------------------------------------------------------------


def _result(
    resolved: ResolvedDataset,
    recipe: MLRecipe,
    hypothesis: str,
    verdict: Verdict,
    rationale: str,
    model_kind: str,
    *,
    metrics: list[tuple[str, str]],
    charts: list[Chart],
) -> MLResult:
    dataset = resolved.dataset
    return MLResult(
        title=f"{recipe.value.title()} · {dataset.name}",
        hypothesis=hypothesis,
        recipe=recipe.value,
        verdict=verdict.value,
        rationale=rationale,
        dataset_name=dataset.name,
        dataset_source=resolved.source_label or f"{resolved.source_platform}:{resolved.source_id}",
        dataset_author=resolved.author,
        n_rows=dataset.n_rows,
        n_features=dataset.n_features,
        model_kind=model_kind,
        metrics=metrics,
        charts=charts,
    )


def _degenerate(
    resolved: ResolvedDataset, recipe: MLRecipe, hypothesis: str, reason: str
) -> MLResult:
    """An honest inconclusive result when the data can't support a conclusion (hard rule 1)."""
    dataset = resolved.dataset
    return _result(
        resolved,
        recipe,
        hypothesis,
        Verdict.INCONCLUSIVE,
        f"Not enough data to judge the hypothesis ({reason}).",
        "n/a",
        metrics=[("rows", str(dataset.n_rows)), ("status", "insufficient data")],
        charts=[],
    )
