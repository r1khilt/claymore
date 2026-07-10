"""[Bio] Dependency-free SVG chart rendering for ML-analysis result cards.

Charts are drawn as self-contained ``<svg>`` strings (no matplotlib, no runtime deps) and embedded
directly in the Composer result card. SVG is the right choice here over a PNG: it is vector (crisp
at any size), tiny, and — because it is pure text built from numbers — deterministic, so the
adversarial suite can assert on it byte-for-byte.

Security note (SECURITY.md rule 7 / hard rule 7): every caller-supplied string that lands in the
SVG (axis titles, the dataset/feature names that came from *untrusted* memory) is routed through
:func:`_esc`, which XML-escapes ``& < > " '``. The numeric series are formatted by us and never
interpolated raw. So a feature literally named ``</svg><script>…`` renders as inert text, never as
markup — the same "untrusted content is data, not instructions" posture the rest of Claymore holds.
"""

from __future__ import annotations

from collections.abc import Sequence

# Canvas geometry — a fixed viewBox the card scales to its column width via ``width="100%"``.
_W = 340
_H = 210
_PAD_L = 44  # room for the y-axis tick labels
_PAD_R = 14
_PAD_T = 16
_PAD_B = 34  # room for the x-axis tick labels + title

# Palette pulled toward the web app's tokens (ink / sage / clay) so cards feel native.
_INK = "#2b2a27"
_MUTED = "#8a857c"
_AXIS = "rgba(0,0,0,0.18)"
_SAGE = "#5f8257"
_CLAY = "#b8654f"
_ACCENT_FILL = "rgba(95,130,87,0.14)"


def _esc(text: str) -> str:
    """XML-escape a string bound for SVG text/attributes (untrusted labels are inert, R7)."""
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
        .replace("'", "&#39;")
    )


def _num(value: float) -> str:
    """Format a coordinate compactly and finitely (NaN/inf never reach the DOM as ``nan``)."""
    if value != value or value in (float("inf"), float("-inf")):  # NaN or ±inf
        return "0"
    return f"{value:.2f}".rstrip("0").rstrip(".") or "0"


class _Frame:
    """Maps data coordinates into the SVG pixel box and emits the shared axes/title chrome."""

    def __init__(
        self, x_lo: float, x_hi: float, y_lo: float, y_hi: float, *, x_label: str, y_label: str
    ) -> None:
        # Guard degenerate ranges (a constant series) so the mapping never divides by zero.
        self._x_lo = x_lo
        self._x_hi = x_hi if x_hi > x_lo else x_lo + 1.0
        self._y_lo = y_lo
        self._y_hi = y_hi if y_hi > y_lo else y_lo + 1.0
        self._x_label = x_label
        self._y_label = y_label

    def px(self, x: float) -> float:
        frac = (x - self._x_lo) / (self._x_hi - self._x_lo)
        return _PAD_L + frac * (_W - _PAD_L - _PAD_R)

    def py(self, y: float) -> float:
        frac = (y - self._y_lo) / (self._y_hi - self._y_lo)
        return _H - _PAD_B - frac * (_H - _PAD_T - _PAD_B)

    def chrome(self) -> list[str]:
        """The axis lines, corner tick labels, and axis titles shared by every chart kind."""
        x0, x1 = _PAD_L, _W - _PAD_R
        y0, y1 = _H - _PAD_B, _PAD_T
        parts = [
            f'<line x1="{x0}" y1="{y0}" x2="{x1}" y2="{y0}" stroke="{_AXIS}" stroke-width="1"/>',
            f'<line x1="{x0}" y1="{y0}" x2="{x0}" y2="{y1}" stroke="{_AXIS}" stroke-width="1"/>',
        ]
        # Corner tick labels: data extents at each axis end.
        parts.append(_text(x0, y0 + 13, _num(self._x_lo), anchor="start", size=9, fill=_MUTED))
        parts.append(_text(x1, y0 + 13, _num(self._x_hi), anchor="end", size=9, fill=_MUTED))
        parts.append(_text(x0 - 6, y0, _num(self._y_lo), anchor="end", size=9, fill=_MUTED))
        parts.append(_text(x0 - 6, y1 + 8, _num(self._y_hi), anchor="end", size=9, fill=_MUTED))
        # Axis titles.
        parts.append(
            _text((x0 + x1) / 2, _H - 6, _esc(self._x_label), anchor="middle", size=10, fill=_INK)
        )
        mid_y = (y0 + y1) / 2
        parts.append(
            f'<text x="12" y="{_num(mid_y)}" font-size="10" fill="{_INK}" '
            f'text-anchor="middle" transform="rotate(-90 12 {_num(mid_y)})" '
            f'font-family="ui-sans-serif,system-ui,sans-serif">{_esc(self._y_label)}</text>'
        )
        return parts


def _text(x: float, y: float, body: str, *, anchor: str, size: int, fill: str) -> str:
    """One SVG ``<text>`` node. ``body`` must already be escaped by the caller when untrusted."""
    return (
        f'<text x="{_num(x)}" y="{_num(y)}" font-size="{size}" fill="{fill}" '
        f'text-anchor="{anchor}" font-family="ui-sans-serif,system-ui,sans-serif">{body}</text>'
    )


def _svg(body: Sequence[str]) -> str:
    """Wrap chart elements in a responsive, self-contained root (scales to the card column)."""
    inner = "".join(body)
    return (
        f'<svg viewBox="0 0 {_W} {_H}" width="100%" role="img" '
        f'xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet" '
        f'style="max-width:100%;height:auto;display:block">{inner}</svg>'
    )


def line_chart(series: Sequence[float], *, x_label: str, y_label: str) -> str:
    """A single line over an integer index — used for the per-epoch training-loss curve.

    An empty or single-point series still returns a valid (near-empty) SVG rather than raising, so
    a degenerate run never breaks the card.
    """
    if not series:
        return _svg(_Frame(0, 1, 0, 1, x_label=x_label, y_label=y_label).chrome())
    frame = _Frame(
        0, max(1, len(series) - 1), min(series), max(series), x_label=x_label, y_label=y_label
    )
    pts = " ".join(f"{_num(frame.px(i))},{_num(frame.py(v))}" for i, v in enumerate(series))
    body = frame.chrome()
    body.append(f'<polyline points="{pts}" fill="none" stroke="{_SAGE}" stroke-width="2"/>')
    return _svg(body)


def scatter_chart(
    xs: Sequence[float],
    ys: Sequence[float],
    *,
    x_label: str,
    y_label: str,
    fit: tuple[float, float] | None = None,
    diagonal: bool = False,
) -> str:
    """A scatter of ``(x, y)`` points, optionally with a fitted line (slope, intercept) or a y=x
    reference diagonal (for predicted-vs-actual). Used by the correlation and regression cards."""
    if not xs or not ys or len(xs) != len(ys):
        return _svg(_Frame(0, 1, 0, 1, x_label=x_label, y_label=y_label).chrome())
    frame = _Frame(min(xs), max(xs), min(ys), max(ys), x_label=x_label, y_label=y_label)
    body = frame.chrome()
    if diagonal:
        lo = min(min(xs), min(ys))
        hi = max(max(xs), max(ys))
        body.append(
            f'<line x1="{_num(frame.px(lo))}" y1="{_num(frame.py(lo))}" '
            f'x2="{_num(frame.px(hi))}" y2="{_num(frame.py(hi))}" '
            f'stroke="{_MUTED}" stroke-width="1" stroke-dasharray="4 3"/>'
        )
    if fit is not None:
        slope, intercept = fit
        x_lo, x_hi = min(xs), max(xs)
        body.append(
            f'<line x1="{_num(frame.px(x_lo))}" y1="{_num(frame.py(slope * x_lo + intercept))}" '
            f'x2="{_num(frame.px(x_hi))}" y2="{_num(frame.py(slope * x_hi + intercept))}" '
            f'stroke="{_CLAY}" stroke-width="2"/>'
        )
    for x, y in zip(xs, ys, strict=True):
        body.append(
            f'<circle cx="{_num(frame.px(x))}" cy="{_num(frame.py(y))}" r="2.6" '
            f'fill="{_SAGE}" fill-opacity="0.72"/>'
        )
    return _svg(body)


def roc_chart(fpr: Sequence[float], tpr: Sequence[float], *, auc: float) -> str:
    """An ROC curve (with the chance diagonal + AUC annotation) for the classification card."""
    frame = _Frame(0, 1, 0, 1, x_label="false positive rate", y_label="true positive rate")
    body = frame.chrome()
    body.append(
        f'<line x1="{_num(frame.px(0))}" y1="{_num(frame.py(0))}" '
        f'x2="{_num(frame.px(1))}" y2="{_num(frame.py(1))}" '
        f'stroke="{_MUTED}" stroke-width="1" stroke-dasharray="4 3"/>'
    )
    if fpr and tpr and len(fpr) == len(tpr):
        area = " ".join(
            f"{_num(frame.px(f))},{_num(frame.py(t))}" for f, t in zip(fpr, tpr, strict=True)
        )
        floor = f"{_num(frame.px(1))},{_num(frame.py(0))} {_num(frame.px(0))},{_num(frame.py(0))}"
        body.append(f'<polygon points="{area} {floor}" fill="{_ACCENT_FILL}" stroke="none"/>')
        body.append(f'<polyline points="{area}" fill="none" stroke="{_SAGE}" stroke-width="2"/>')
    body.append(
        _text(_W - _PAD_R - 4, _PAD_T + 12, f"AUC {auc:.2f}", anchor="end", size=11, fill=_INK)
    )
    return _svg(body)
