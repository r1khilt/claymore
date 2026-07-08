"""[Brain, Phase 3] ``ComputeBackend`` adapters — E2B (light) / Modal (GPU) / HPC-over-SSH.

microVM isolation (Firecracker/gVisor), deny-by-default egress, ephemeral + resource-limited, no
secrets in the sandbox env (SECURITY.md §4). Runs only in a sandbox, never the host (hard rule 3).

TODO(Phase 3): implement run() per backend behind claymore.ports.ComputeBackend.
"""

from __future__ import annotations
