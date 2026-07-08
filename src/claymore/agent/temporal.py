"""[Brain] Temporal-expression resolver (BUILD_PLAN.md §4.5).

Resolves fuzzy relative time in queries ("last week," "a couple months ago") to an explicit
bi-temporal ``valid_from/valid_to`` window in the asker's timezone (captured at enrollment), and
echoes the resolved window in the answer so temporal ambiguity is visible, not silent.

TODO(Phase 2): parse relative expressions -> (valid_from, valid_to) in asker tz.
"""

from __future__ import annotations
