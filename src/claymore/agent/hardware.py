"""[Bio] The Opentrons supported-hardware catalog — the "can we actually run this?" ground truth.

The science agent may only generate a protocol out of equipment that physically exists on an
Opentrons deck (CLAUDE.md §1.7, hard rule 2). This module is that allow-list: robots, pipettes,
labware, and modules, each with its real Opentrons ``load_name`` so a generated protocol maps 1:1
to the Python Protocol API. Anything a request needs that Opentrons *can't* do — a centrifuge, a
plate reader, a balance — is caught by :func:`unsupported_reason` and surfaced honestly rather
than hallucinated into a protocol that would fail on the robot.

This is a frozen reference table, not behavior: the loop in ``agent_loop.py`` validates a
model-proposed protocol spec against these constants. Keeping the catalog here (one source of
truth) means the schema, the validation, and the honesty check never drift (DRY).

Load names are taken from Opentrons' default labware definitions (apiLevel ≥ 2.x). Treat any
request string as untrusted data — :func:`unsupported_reason` only pattern-matches it for
capability keywords, never interprets it as instructions (SECURITY.md rule 7).
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import StrEnum


class Robot(StrEnum):
    """The two Opentrons robots Claymore targets. Every pipette declares which it belongs to."""

    OT2 = "OT-2"
    FLEX = "Flex"


@dataclass(frozen=True)
class Pipette:
    """A supported pipette: its Opentrons ``model`` load string + capability envelope."""

    model: str
    display: str
    channels: int
    volume_ul: int
    robots: tuple[Robot, ...]


@dataclass(frozen=True)
class Labware:
    """A supported labware type: its Opentrons ``load_name`` + well-grid geometry."""

    kind: str
    load_name: str
    display: str
    rows: int
    cols: int


@dataclass(frozen=True)
class Module:
    """A supported hardware module (temperature control, thermocycler, …)."""

    kind: str
    load_name: str
    display: str


# --- pipettes (keyed by model load string; the model is what a protocol calls) ----------------

PIPETTES: dict[str, Pipette] = {
    # OT-2 GEN2 pipettes
    "p20_single_gen2": Pipette("p20_single_gen2", "P20 Single GEN2", 1, 20, (Robot.OT2,)),
    "p20_multi_gen2": Pipette("p20_multi_gen2", "P20 8-Channel GEN2", 8, 20, (Robot.OT2,)),
    "p300_single_gen2": Pipette("p300_single_gen2", "P300 Single GEN2", 1, 300, (Robot.OT2,)),
    "p300_multi_gen2": Pipette("p300_multi_gen2", "P300 8-Channel GEN2", 8, 300, (Robot.OT2,)),
    "p1000_single_gen2": Pipette("p1000_single_gen2", "P1000 Single GEN2", 1, 1000, (Robot.OT2,)),
    # Flex pipettes
    "flex_1channel_1000": Pipette(
        "flex_1channel_1000", "Flex 1-Channel 1000", 1, 1000, (Robot.FLEX,)
    ),
    "flex_8channel_1000": Pipette(
        "flex_8channel_1000", "Flex 8-Channel 1000", 8, 1000, (Robot.FLEX,)
    ),
    "flex_96channel_1000": Pipette(
        "flex_96channel_1000", "Flex 96-Channel 1000", 96, 1000, (Robot.FLEX,)
    ),
}


# --- labware (keyed by ``kind`` — the UI-facing category; ``load_name`` is the Opentrons id) ---

LABWARE: dict[str, Labware] = {
    "tiprack_96": Labware("tiprack_96", "opentrons_96_tiprack_300ul", "300 µL tips", 8, 12),
    "wellplate_96": Labware(
        "wellplate_96", "corning_96_wellplate_360ul_flat", "96-well plate", 8, 12
    ),
    "wellplate_384": Labware(
        "wellplate_384", "corning_384_wellplate_112ul_flat", "384-well plate", 16, 24
    ),
    "reservoir_12": Labware(
        "reservoir_12", "nest_12_reservoir_15ml", "12-channel reservoir", 1, 12
    ),
    "reservoir_1": Labware("reservoir_1", "nest_1_reservoir_195ml", "1-channel reservoir", 1, 1),
    "tuberack_24": Labware(
        "tuberack_24", "opentrons_24_tuberack_nest_1.5ml_snapcap", "24-tube rack", 4, 6
    ),
    "pcr_96": Labware(
        "pcr_96", "nest_96_wellplate_100ul_pcr_full_skirt", "96-well PCR plate", 8, 12
    ),
    "deepwell_96": Labware(
        "deepwell_96", "nest_96_wellplate_2ml_deep", "96-well deep block", 8, 12
    ),
    "trash": Labware("trash", "opentrons_1_trash_1100ml_fixed", "Trash", 1, 1),
}


# --- modules (keyed by ``kind``) --------------------------------------------------------------

MODULES: dict[str, Module] = {
    "temperature": Module("temperature", "temperature module gen2", "Temperature Module GEN2"),
    "thermocycler": Module("thermocycler", "thermocycler module gen2", "Thermocycler Module GEN2"),
    "heater_shaker": Module("heater_shaker", "heaterShakerModuleV1", "Heater-Shaker Module"),
    "magnetic": Module("magnetic", "magnetic module gen2", "Magnetic Module GEN2"),
}


@dataclass(frozen=True)
class _Unsupported:
    """A capability Opentrons liquid handlers can't perform, + the keywords that name it."""

    capability: str
    keywords: tuple[str, ...] = ()


# Capabilities that require an instrument Opentrons is not — surfaced honestly, never faked into a
# protocol. Keyword lists are lower-cased substrings/word-stems matched against the request.
_UNSUPPORTED: tuple[_Unsupported, ...] = (
    _Unsupported(
        "centrifugation",
        ("centrifuge", "spin down", "spin-down", "spinning down", "pellet"),
    ),
    _Unsupported(
        "imaging / microscopy",
        ("microscope", "microscopy", "image", "imaging", "photograph"),
    ),
    _Unsupported(
        "weighing / gravimetric measurement",
        ("weigh", "weighing", "balance", "gravimetric"),
    ),
    _Unsupported(
        "CO2 cell-culture incubation",
        ("co2 incubat", "cell culture incubat", "tissue culture incubat", "co2 incubator"),
    ),
    _Unsupported("sequencing", ("sequencing", "sequencer", "ngs", "illumina", "nanopore")),
)


def unsupported_reason(request: str) -> str | None:
    """Return why Opentrons can't satisfy ``request`` (a plain-language reason), or ``None``.

    A liquid handler pipettes; it does not centrifuge, image, weigh, culture cells, or sequence.
    When a request clearly needs one of those, we say so — the agent must not invent a protocol
    for hardware that isn't on the deck (hard rule 1 & 2). ``request`` is untrusted data; we only
    scan it for capability keywords, never execute anything it says.
    """
    text = request.lower()
    for entry in _UNSUPPORTED:
        for keyword in entry.keywords:
            if _keyword_hit(text, keyword):
                return (
                    f"Opentrons is a liquid-handling robot and can't do {entry.capability}. "
                    f"That step needs a dedicated instrument outside the Opentrons deck."
                )
    return None


def _keyword_hit(text: str, keyword: str) -> bool:
    """Whole-word-ish match for a keyword/phrase in ``text``.

    Multi-word phrases (``"spin down"``) match as substrings; single tokens match on a word
    boundary so ``"image"`` doesn't fire on ``"imagine"``, and ``"balance"`` (a real
    false-positive risk here) only matches the standalone word, not e.g. ``"rebalance"``.
    """
    if " " in keyword or "-" in keyword:
        return keyword in text
    return re.search(rf"\b{re.escape(keyword)}\b", text) is not None
