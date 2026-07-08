"""[Brain] Cross-source identity resolution (R11) — resolve authors BEFORE graph-write.

Resolves an episode's author to a canonical lab ``Person`` across platforms (Slack handle ↔
email ↔ GitHub login ↔ Granola speaker label), seeded from the lab roster at enrollment
(``User.platform_handles``). Resolution is **deterministic only**: exact match after
normalization. Anything ambiguous, unseeded, or diarization-grade ("Speaker 1") resolves to
``UNKNOWN_AUTHOR`` and is surfaced — never guessed (hard rule 1). The LLM-assisted merge for
unknowns (behind a confidence gate) is a later, additive step; it must propose merges into the
roster, not silently rewrite authors.

Must run before facts are stored — retrofitting identity onto a populated graph is a rewrite.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Sequence

import structlog

from claymore.auth.models import User
from claymore.domain import UNKNOWN_AUTHOR, LabId, PersonId, SourcePlatform
from claymore.ingest.normalize import Episode

logger = structlog.get_logger(__name__)

# Sentinel marking a handle claimed by 2+ people on the same platform. Ambiguity is treated as
# unresolvable (never guess between two lab members), and logged once at seed time.
_AMBIGUOUS = object()

# "Display Name <user@example.com>" → capture the address part.
_EMAIL_IN_ANGLE_BRACKETS = re.compile(r"<([^<>@\s]+@[^<>@\s]+)>\s*$")

# Diarization placeholders that must never be treated as a name ("Speaker 1", "speaker_2").
_DIARIZATION_LABEL = re.compile(r"^speaker[\s_-]*\d+$")

# Episode.extra key Pipes uses to pass the raw, platform-native author reference when
# Episode.author has not been resolved yet.
RAW_AUTHOR_KEY = "raw_author"


def normalize_handle(raw: str) -> str:
    """Canonicalize a platform handle for exact matching.

    NFKC-fold unicode (so a full-width or composed variant can't dodge or spoof a match),
    casefold, trim, strip one leading ``@``, and reduce ``Name <a@b>`` to ``a@b``. Purely
    syntactic — this must never become fuzzy matching (R11).
    """
    text = unicodedata.normalize("NFKC", raw).strip()
    if match := _EMAIL_IN_ANGLE_BRACKETS.search(text):
        text = match.group(1)
    return text.casefold().removeprefix("@").strip()


class IdentityResolver:
    """Roster-seeded resolver for one lab. Build once per lab from its enrolled ``User``s."""

    def __init__(self, lab_id: LabId, roster: Sequence[User]) -> None:
        self._lab_id = lab_id
        self._person_ids: frozenset[PersonId] = frozenset(
            u.person_id for u in roster if u.lab_id == lab_id
        )
        # (platform, normalized handle) → PersonId | _AMBIGUOUS
        self._index: dict[tuple[SourcePlatform, str], object] = {}
        for user in roster:
            if user.lab_id != lab_id:
                # Fail closed: a roster row from another lab must never seed this resolver
                # (R10 — cross-tenant identity bleed would misattribute facts).
                logger.warning(
                    "identity.roster_wrong_lab", expected=lab_id, got=user.lab_id, user=user.id
                )
                continue
            for platform, handle in user.platform_handles.items():
                key = (platform, normalize_handle(handle))
                if not key[1]:
                    continue
                existing = self._index.get(key)
                if existing is not None and existing != user.person_id:
                    self._index[key] = _AMBIGUOUS
                    logger.warning("identity.ambiguous_handle", platform=platform, lab_id=lab_id)
                else:
                    self._index[key] = user.person_id

    def is_canonical(self, person_id: PersonId) -> bool:
        """Whether ``person_id`` is a known lab person (i.e. already resolved)."""
        return person_id in self._person_ids

    def resolve(self, platform: SourcePlatform, raw_handle: str) -> PersonId:
        """Resolve one platform handle → canonical person, or ``UNKNOWN_AUTHOR``."""
        normalized = normalize_handle(raw_handle)
        if not normalized:
            return UNKNOWN_AUTHOR
        hit = self._index.get((platform, normalized))
        if hit is None or hit is _AMBIGUOUS:
            return UNKNOWN_AUTHOR
        assert isinstance(hit, str)  # narrowed: index stores PersonId | _AMBIGUOUS
        return hit

    def resolve_speaker(self, label: str, attendees: Sequence[str]) -> PersonId:
        """Map a Granola speaker label to a meeting attendee — the weakest source (R11).

        A label counts only if it is a real name/handle (not a diarization placeholder) that
        matches exactly **one** attendee, and that attendee resolves to a known person via the
        roster (attendees are the platform-native strings Granola reports, typically emails).
        Everything else → ``UNKNOWN_AUTHOR``.
        """
        normalized_label = normalize_handle(label)
        if not normalized_label or _DIARIZATION_LABEL.match(normalized_label):
            return UNKNOWN_AUTHOR
        matches = {
            resolved
            for attendee in attendees
            if normalized_label == normalize_handle(attendee)
            or normalized_label == normalize_handle(attendee).split("@")[0]
            if (resolved := self.resolve(SourcePlatform.GMAIL, attendee)) != UNKNOWN_AUTHOR
        }
        if len(matches) != 1:
            return UNKNOWN_AUTHOR
        return matches.pop()

    def resolve_episode(self, episode: Episode) -> Episode:
        """Return the episode with a canonical (or explicitly unknown) author.

        Resolution order: an already-canonical ``author`` passes through; else the raw handle in
        ``extra["raw_author"]`` is resolved for the episode's platform; a Granola episode also
        tries speaker→attendee mapping (``extra["attendees"]``, comma-separated). No path
        guesses: the fallback is always ``UNKNOWN_AUTHOR``.
        """
        if episode.lab_id != self._lab_id:
            raise ValueError(
                f"episode lab_id {episode.lab_id!r} does not match resolver lab {self._lab_id!r}"
            )
        if self.is_canonical(episode.author):
            return episode

        raw = episode.extra.get(RAW_AUTHOR_KEY, "")
        candidate = episode.author if episode.author != UNKNOWN_AUTHOR else ""
        resolved = UNKNOWN_AUTHOR
        for attempt in (raw, candidate):
            if attempt:
                resolved = self.resolve(episode.source_platform, attempt)
                if resolved != UNKNOWN_AUTHOR:
                    break
        if resolved == UNKNOWN_AUTHOR and episode.source_platform is SourcePlatform.GRANOLA:
            attendees = [a for a in episode.extra.get("attendees", "").split(",") if a.strip()]
            resolved = self.resolve_speaker(raw or candidate, attendees)

        if resolved == UNKNOWN_AUTHOR:
            logger.info(
                "identity.unresolved_author",
                lab_id=episode.lab_id,
                platform=episode.source_platform,
                source_id=episode.source_id,
            )
        return episode.model_copy(update={"author": resolved})
