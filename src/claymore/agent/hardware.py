"""[Bio] The Opentrons supported-hardware catalog — the "can we actually run this?" ground truth.

The science agent designs a scene out of equipment that physically exists on an Opentrons deck
(CLAUDE.md §1.7, hard rule 2). This module is that allow-list: robots, pipettes, labware, modules,
and accessories, each with its real Opentrons ``load_name`` so a generated scene maps 1:1 to the
Python Protocol API. It mirrors ``web/src/lib/hardware.ts`` field-for-field so the live agent and
the web mock render identical scenes.

When a request needs a capability a liquid handler doesn't have (a centrifuge, a plate imager),
:func:`capability_gap` names it — the agent then builds a *general lab-robot* scene + a PyLabRobot
movement script rather than refusing (the deck still shows what the run would do). Treat any request
string as untrusted data: the gap check only pattern-matches capability keywords, never interprets
the text as instructions (SECURITY.md rule 7).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from enum import StrEnum


class Robot(StrEnum):
    """The robots Claymore can draw. ``GENERIC`` is the neutral bench for off-Opentrons scenes."""

    OT2 = "OT-2"
    FLEX = "Flex"
    GENERIC = "Generic"


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
    """A supported labware type: its Opentrons ``load_name`` + geometry + render hints."""

    kind: str
    load_name: str
    display: str
    category: str  # tips | plate | reservoir | tuberack | block | lid | trash
    shape: str  # wells | tubes | strips | reservoir | tips | flat | trash
    rows: int
    cols: int
    well_ul: int = 0


@dataclass(frozen=True)
class Module:
    """A supported hardware module (temperature control, thermocycler, plate reader, …)."""

    kind: str
    load_name: str
    display: str
    short: str
    tint: str
    robots: tuple[Robot, ...]
    behavior: tuple[str, ...] = field(default_factory=tuple)  # heats/cools/shakes/magnet/lid/reads…


@dataclass(frozen=True)
class Accessory:
    """A deck accessory (gripper, waste chute, trash bin)."""

    kind: str
    display: str
    robots: tuple[Robot, ...]


# --- pipettes (keyed by model load string; the model is what a protocol calls) ----------------

PIPETTES: dict[str, Pipette] = {
    # OT-2 GEN2
    "p20_single_gen2": Pipette("p20_single_gen2", "P20 Single", 1, 20, (Robot.OT2,)),
    "p20_multi_gen2": Pipette("p20_multi_gen2", "P20 8-Channel", 8, 20, (Robot.OT2,)),
    "p300_single_gen2": Pipette("p300_single_gen2", "P300 Single", 1, 300, (Robot.OT2,)),
    "p300_multi_gen2": Pipette("p300_multi_gen2", "P300 8-Channel", 8, 300, (Robot.OT2,)),
    "p1000_single_gen2": Pipette("p1000_single_gen2", "P1000 Single", 1, 1000, (Robot.OT2,)),
    # Flex
    "flex_1channel_50": Pipette("flex_1channel_50", "Flex 1-Channel 50", 1, 50, (Robot.FLEX,)),
    "flex_1channel_1000": Pipette(
        "flex_1channel_1000", "Flex 1-Channel 1000", 1, 1000, (Robot.FLEX,)
    ),
    "flex_8channel_50": Pipette("flex_8channel_50", "Flex 8-Channel 50", 8, 50, (Robot.FLEX,)),
    "flex_8channel_1000": Pipette(
        "flex_8channel_1000", "Flex 8-Channel 1000", 8, 1000, (Robot.FLEX,)
    ),
    "flex_96channel_1000": Pipette(
        "flex_96channel_1000", "Flex 96-Channel", 96, 1000, (Robot.FLEX,)
    ),
}


# --- labware (keyed by ``kind``; ``load_name`` is the Opentrons id a protocol loads) -----------


def _lw(
    kind: str, load: str, display: str, cat: str, shape: str, rows: int, cols: int, ul: int = 0
) -> Labware:
    return Labware(kind, load, display, cat, shape, rows, cols, ul)


LABWARE: dict[str, Labware] = {
    # tip racks (all 8×12)  # noqa: RUF003
    "tiprack_flex_50": _lw(
        "tiprack_flex_50",
        "opentrons_flex_96_tiprack_50ul",
        "50 µL Flex tips",
        "tips",
        "tips",
        8,
        12,
        50,
    ),
    "tiprack_flex_200": _lw(
        "tiprack_flex_200",
        "opentrons_flex_96_tiprack_200ul",
        "200 µL Flex tips",
        "tips",
        "tips",
        8,
        12,
        200,
    ),
    "tiprack_flex_1000": _lw(
        "tiprack_flex_1000",
        "opentrons_flex_96_tiprack_1000ul",
        "1000 µL Flex tips",
        "tips",
        "tips",
        8,
        12,
        1000,
    ),
    "tiprack_flex_200_filtered": _lw(
        "tiprack_flex_200_filtered",
        "opentrons_flex_96_filtertiprack_200ul",
        "200 µL Flex filter tips",
        "tips",
        "tips",
        8,
        12,
        200,
    ),
    "tiprack_300": _lw(
        "tiprack_300", "opentrons_96_tiprack_300ul", "300 µL tips", "tips", "tips", 8, 12, 300
    ),
    "tiprack_20": _lw(
        "tiprack_20", "opentrons_96_tiprack_20ul", "20 µL tips", "tips", "tips", 8, 12, 20
    ),
    "tiprack_1000": _lw(
        "tiprack_1000", "opentrons_96_tiprack_1000ul", "1000 µL tips", "tips", "tips", 8, 12, 1000
    ),
    "tiprack_20_filtered": _lw(
        "tiprack_20_filtered",
        "opentrons_96_filtertiprack_20ul",
        "20 µL filter tips",
        "tips",
        "tips",
        8,
        12,
        20,
    ),
    # well plates
    "wellplate_6": _lw(
        "wellplate_6",
        "corning_6_wellplate_16.8ml_flat",
        "6-well plate",
        "plate",
        "wells",
        2,
        3,
        16800,
    ),
    "wellplate_12": _lw(
        "wellplate_12",
        "corning_12_wellplate_6.9ml_flat",
        "12-well plate",
        "plate",
        "wells",
        3,
        4,
        6900,
    ),
    "wellplate_24": _lw(
        "wellplate_24",
        "corning_24_wellplate_3.4ml_flat",
        "24-well plate",
        "plate",
        "wells",
        4,
        6,
        3400,
    ),
    "wellplate_48": _lw(
        "wellplate_48",
        "corning_48_wellplate_1.6ml_flat",
        "48-well plate",
        "plate",
        "wells",
        6,
        8,
        1600,
    ),
    "wellplate_96": _lw(
        "wellplate_96",
        "corning_96_wellplate_360ul_flat",
        "96-well plate",
        "plate",
        "wells",
        8,
        12,
        360,
    ),
    "wellplate_384": _lw(
        "wellplate_384",
        "corning_384_wellplate_112ul_flat",
        "384-well plate",
        "plate",
        "wells",
        16,
        24,
        112,
    ),
    "pcr_96": _lw(
        "pcr_96",
        "nest_96_wellplate_100ul_pcr_full_skirt",
        "96 PCR plate",
        "plate",
        "wells",
        8,
        12,
        100,
    ),
    "deepwell_96": _lw(
        "deepwell_96",
        "nest_96_wellplate_2ml_deep",
        "96 deep-well block",
        "plate",
        "wells",
        8,
        12,
        2000,
    ),
    # reservoirs
    "reservoir_1": _lw(
        "reservoir_1",
        "nest_1_reservoir_195ml",
        "1-well reservoir",
        "reservoir",
        "reservoir",
        1,
        1,
        195000,
    ),
    "reservoir_12": _lw(
        "reservoir_12",
        "nest_12_reservoir_15ml",
        "12-well reservoir",
        "reservoir",
        "reservoir",
        1,
        12,
        15000,
    ),
    # tube racks
    "tuberack_6_50ml": _lw(
        "tuberack_6_50ml",
        "opentrons_6_tuberack_falcon_50ml_conical",
        "6× 50 mL rack",  # noqa: RUF001
        "tuberack",
        "tubes",
        2,
        3,
        50000,
    ),
    "tuberack_15_15ml": _lw(
        "tuberack_15_15ml",
        "opentrons_15_tuberack_falcon_15ml_conical",
        "15× 15 mL rack",  # noqa: RUF001
        "tuberack",
        "tubes",
        3,
        5,
        15000,
    ),
    "tuberack_10_combo": _lw(
        "tuberack_10_combo",
        "opentrons_10_tuberack_falcon_4x50ml_6x15ml_conical",
        "10-tube combo rack",
        "tuberack",
        "tubes",
        2,
        5,
        50000,
    ),
    "tuberack_24_1500": _lw(
        "tuberack_24_1500",
        "opentrons_24_tuberack_nest_1.5ml_snapcap",
        "24× 1.5 mL rack",  # noqa: RUF001
        "tuberack",
        "tubes",
        4,
        6,
        1500,
    ),
    "tuberack_24_2000": _lw(
        "tuberack_24_2000",
        "opentrons_24_tuberack_nest_2ml_snapcap",
        "24× 2 mL rack",  # noqa: RUF001
        "tuberack",
        "tubes",
        4,
        6,
        2000,
    ),
    "tuberack_24_500": _lw(
        "tuberack_24_500",
        "opentrons_24_tuberack_nest_0.5ml_screwcap",
        "24× 0.5 mL rack",  # noqa: RUF001
        "tuberack",
        "tubes",
        4,
        6,
        500,
    ),
    # aluminum blocks + strips
    "block_96_pcr": _lw(
        "block_96_pcr",
        "opentrons_96_aluminumblock_nest_wellplate_100ul",
        "96-well aluminum block",
        "block",
        "wells",
        8,
        12,
        100,
    ),
    "block_24_2ml": _lw(
        "block_24_2ml",
        "opentrons_24_aluminumblock_generic_2ml_screwcap",
        "24-tube aluminum block",
        "block",
        "tubes",
        4,
        6,
        2000,
    ),
    "block_pcr_strips": _lw(
        "block_pcr_strips",
        "opentrons_96_aluminumblock_generic_pcr_strip_200ul",
        "PCR strips (aluminum block)",
        "block",
        "strips",
        8,
        12,
        200,
    ),
    # lid + trash
    "pcr_lid": _lw(
        "pcr_lid",
        "opentrons_tough_pcr_auto_sealing_lid",
        "PCR sealing lid",
        "lid",
        "flat",
        8,
        12,
        0,
    ),
    "trash": _lw("trash", "opentrons_1_trash_1100ml_fixed", "Trash", "trash", "trash", 1, 1, 0),
}


# --- modules (keyed by ``kind``) --------------------------------------------------------------

MODULES: dict[str, Module] = {
    "temperature": Module(
        "temperature",
        "temperature module gen2",
        "Temperature Module GEN2",
        "TEMP",
        "#4a6fa5",
        (Robot.OT2, Robot.FLEX),
        ("heats", "cools"),
    ),
    "thermocycler": Module(
        "thermocycler",
        "thermocycler module gen2",
        "Thermocycler GEN2",
        "TC",
        "#b4623f",
        (Robot.OT2, Robot.FLEX),
        ("heats", "cools", "lid"),
    ),
    "heater_shaker": Module(
        "heater_shaker",
        "heaterShakerModuleV1",
        "Heater-Shaker",
        "H/S",
        "#c67f3d",
        (Robot.OT2, Robot.FLEX),
        ("heats", "shakes"),
    ),
    "magnetic": Module(
        "magnetic",
        "magnetic module gen2",
        "Magnetic Module GEN2",
        "MAG",
        "#7a5ea8",
        (Robot.OT2,),
        ("magnet",),
    ),
    "magnetic_block": Module(
        "magnetic_block",
        "magneticBlockV1",
        "Magnetic Block GEN1",
        "MAG",
        "#7a5ea8",
        (Robot.FLEX,),
        ("magnet",),
    ),
    "absorbance": Module(
        "absorbance",
        "absorbanceReaderV1",
        "Absorbance Plate Reader",
        "ABS",
        "#2f7d7a",
        (Robot.FLEX,),
        ("reads", "lid"),
    ),
    "hepa_uv": Module(
        "hepa_uv", "hepaUVModule", "HEPA/UV Module", "HEPA", "#5f6d7a", (Robot.FLEX,), ("hood",)
    ),
    "stacker": Module(
        "stacker",
        "flexStackerModuleV1",
        "Flex Stacker",
        "STK",
        "#516b52",
        (Robot.FLEX,),
        ("stacker",),
    ),
}


# --- accessories ------------------------------------------------------------------------------

ACCESSORIES: dict[str, Accessory] = {
    "gripper": Accessory("gripper", "Flex Gripper", (Robot.FLEX,)),
    "waste_chute": Accessory("waste_chute", "Waste Chute", (Robot.FLEX,)),
    "trash_bin": Accessory("trash_bin", "Trash Bin", (Robot.FLEX,)),
}


# --- liquid palette (warm, legible; assigned round-robin by the generators) -------------------

LIQUID_PALETTE: tuple[str, ...] = (
    "#57a07b",
    "#d99a54",
    "#5b8dd6",
    "#c96a6a",
    "#8a6fc0",
    "#4fb0a5",
    "#d5b04a",
    "#7ba0a8",
)


def palette_color(i: int) -> str:
    return LIQUID_PALETTE[i % len(LIQUID_PALETTE)]


# --- capability gap (the general-robot fallback) ----------------------------------------------


@dataclass(frozen=True)
class CapabilityGap:
    """A capability a liquid handler lacks + the off-deck instrument that would do it."""

    capability: str
    instrument: str


@dataclass(frozen=True)
class _Gap:
    keywords: tuple[str, ...]
    capability: str
    instrument: str


_GAPS: tuple[_Gap, ...] = (
    _Gap(
        ("centrifuge", "spin down", "spin-down", "spinning down", "pellet the"),
        "centrifugation",
        "benchtop centrifuge",
    ),
    _Gap(
        ("microscope", "microscopy", "image the", "imaging", "photograph", "confocal"),
        "imaging / microscopy",
        "automated microscope",
    ),
    _Gap(("weigh", "weighing", "balance", "gravimetric"), "weighing", "analytical balance"),
    _Gap(
        ("co2 incubat", "cell culture incubat", "tissue culture incubat", "passage cells"),
        "CO₂ cell culture",
        "CO₂ incubator + cell shuttle",
    ),
    _Gap(
        ("sequencing", "sequencer", "nanopore", "illumina", "minion"),
        "sequencing",
        "sequencer (Illumina / ONT)",
    ),
    _Gap(("electroporat",), "electroporation", "electroporator"),
    _Gap(("sonicat",), "sonication", "sonicator"),
    _Gap(("flow cytometr", "facs"), "flow cytometry", "flow cytometer"),
    _Gap(("colony pick", "colony-pick"), "colony picking", "colony picker"),
)


def capability_gap(request: str) -> CapabilityGap | None:
    """Name the capability a liquid handler lacks for ``request``, else ``None`` (untrusted data)."""  # noqa: E501
    text = request.lower()
    for gap in _GAPS:
        for keyword in gap.keywords:
            if _keyword_hit(text, keyword):
                return CapabilityGap(gap.capability, gap.instrument)
    return None


def _keyword_hit(text: str, keyword: str) -> bool:
    """Whole-word-ish match: phrases as substrings, single tokens on a word boundary."""
    if " " in keyword or "-" in keyword:
        return keyword in text
    return re.search(rf"\b{re.escape(keyword)}\b", text) is not None


def unsupported_reason(request: str) -> str | None:
    """Back-compat one-line reason (or ``None``). Prefer :func:`capability_gap`."""
    gap = capability_gap(request)
    if gap is None:
        return None
    return f"{gap.capability} — needs a {gap.instrument}, off the Opentrons deck"


# --- catalog summary for the system prompt ----------------------------------------------------


def catalog_summary() -> str:
    """A compact, model-facing inventory of what the deck supports (for the system prompt)."""
    pipettes = ", ".join(sorted(PIPETTES))
    labware = ", ".join(sorted(LABWARE))
    modules = ", ".join(sorted(MODULES))
    accessories = ", ".join(sorted(ACCESSORIES))
    return (
        f"Robots: OT-2, Flex.\n"
        f"Pipettes: {pipettes}.\n"
        f"Labware kinds: {labware}.\n"
        f"Modules: {modules}.\n"
        f"Accessories: {accessories}."
    )
