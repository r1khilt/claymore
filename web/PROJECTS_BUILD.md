# Projects + Live Knowledge Graph — Build Doc

> Self-contained spec for building the **Projects** feature in `web/`. A fresh session
> should be able to execute this end-to-end. Written against repo HEAD `d347dd2` (branch
> `main`). Read this whole file before writing code.

---

## 0. TL;DR of what you're building

A **Projects** tab. A project = a research question + a paper corpus. Flow:

1. Team drops in ≥1 papers; each source shows **who added it** (attribution).
2. Hit **Create Graph**. If corpus `< 6` sources, a **sufficiency gate** auto-expands it via
   **Exa** (validated papers), clearly marking human-added vs auto-sourced.
3. A **live 3D causal knowledge graph** streams in node-by-node (genes/proteins/hypotheses/
   methods/results as nodes, relations as edges) with a bloom-into-place animation.
4. A **gap engine** ranks untested links / contradictions as concrete experiments, each **cited**.
5. For any gap, **Run this now** → dispatch to the existing compute/Claude-Science path or the
   Opentrons sim (wet-lab stays human-gated).
6. Result reports back, the corresponding **edge resolves** (dashed-gold → green, or cracks red),
   and Claymore **auto-drafts a conversational Slack message** summarizing it → one-tap **Send**.

The moat is the **gap engine** (a real method, not "LLM opinion") + the **closing loop** on a live
3D brain. Judges = Anthropic + Gladstone; they reward real scientific method, reproducibility,
causal rigor, honest attribution.

---

## 1. Hard constraints (read first)

- **Work in `web/` only.** Backend stays untouched for the demo (client-mock, same seam as
  everything else). A live backend route is optional and out of the week's critical path.
- **All feature logic is net-new files.** The ONLY edits to existing files are the **exactly-3
  wiring lines** in §9. Do not modify any existing component's logic.
- **Branch off `d347dd2`** (`git switch -c feat/projects d347dd2`). Teammates work on worktrees;
  don't rebase or touch their files.
- **Match the existing UI language exactly** (§4). The current "Run" ingest flow is the quality bar.
- **Never fabricate attribution.** Human-added sources carry the person; Exa-added carry
  `addedBy: 'exa'`, visibly distinct. This is a product hard rule (`CLAUDE.md` §2.1).
- **Mock-default, live-behind-flag.** Follow `lib/agent.ts`: the mock path is the default; a live
  path activates behind `import.meta.env.VITE_CLAYMORE_LIVE === '1'`. The demo runs the mock so it
  never flakes on stage.

---

## 2. Repo ground truth (what's real vs mock)

Reuse, don't rebuild:

| Thing | File | State |
|---|---|---|
| Streaming-agent UI pattern (the bar) | `components/run/RunView.tsx` | REAL, mirror it |
| Async-generator event engine (the bar) | `lib/autopilot.ts` | REAL, mirror it |
| Tool-call trace renderer | `components/ask/AgentTurn.tsx` | REAL, reuse for runs |
| Answer + citations renderer | `components/ask/AnswerView.tsx` | REAL, reuse |
| Platform chips + icons | `lib/sources.tsx` (`PlatformIcon`, `PLATFORM`) | REAL, reuse |
| Avatar | `components/ui/Avatar.tsx` | REAL, reuse |
| Citation / Person / Entity types | `lib/types.ts` | REAL, import + extend |
| Shared cited corpus | `lib/mockData.ts` (`CIT`, `connectors`) | REAL, reuse for citations |
| Run dispatch (compute / Claude Science / sim) | `components/run/RunView.tsx` + `lib/autopilot.ts` + `lib/deck.ts` + `lib/protocol.ts` | REAL, dispatch into it |
| Slack write-back / approval shape | `PendingAction` in `lib/types.ts` | REAL, reuse |
| 3D scene patterns (Canvas + OrbitControls + useFrame) | `components/bench/Deck3D.tsx` | REAL, copy patterns |
| Design tokens | `index.css` (`@theme`) | REAL, use tokens |

Stack already present: `three@0.185`, `@react-three/fiber@9`, `@react-three/drei@10`,
`framer-motion@12`, `lucide-react`, Tailwind v4, `@/` path alias.

---

## 3. Feature spec (the flow, precise)

**Entry.** A `Projects` nav item mounts `ProjectsView`. It shows a **project list** (cards) →
click opens **project detail**. Detail has three zones: left/center **3D graph**, right **gap panel**,
top **source dropzone** (collapses after graph is built).

**Source input + attribution.** `SourceDropzone` lets a user add a paper (title/DOI/paste). Each
`PaperSource.addedBy` is `{kind:'human', person}` or `{kind:'exa'}`. Show a contributor avatar per
source; Exa sources get an "auto-sourced" ring/badge.

**Create Graph → build stream.** `buildGraph()` is an **async generator** (mirror `runAutopilot`)
that yields, in order: sufficiency check → (if needed) Exa augment sources → per-paper extraction →
nodes → edges → settled → gaps → done. The UI consumes it exactly like `RunView.consume()` with a
phase machine and `AbortController`.

**3D graph.** `KnowledgeGraph3D` renders one `<Canvas>` with nodes/edges positioned by
`d3-force-3d`, glow via `@react-three/postprocessing` Bloom, camera via drei `OrbitControls`.
Streaming: append nodes into state as `graph:node` events arrive → reheat the sim → they bloom in.

**Gap panel.** `GapPanel` lists ranked gaps. Click a gap → highlight its subgraph in 3D + show
bridging citations. Each gap has **Run this now**.

**Run.** Dispatch the gap's `proposedRun` into the existing run machinery. Reuse `experiment()`
(AgentEvent stream) + `AgentTurn` for the trace, `AnswerView` for the result.

**Resolve + tell the team.** On result: flip the gap's edge `state` (`predicted`→`confirmed`/
`refuted`) with an animation; render `RunResultCard`; then pop `SlackDraftBubble` — a grounded,
conversational draft ("hey — ran the co-IP the graph flagged, here's what came back, thoughts?")
with a **Send** button that reuses the `PendingAction`/Composio write-back path.

---

## 4. UI design language (MATCH THIS — extracted from `RunView.tsx`)

This is the quality bar the user cares about. Copy these patterns verbatim.

**Layout skeleton**
```tsx
<div className="flex h-full flex-col">
  {/* header: pill buttons left/right */}
  <div className="flex items-center justify-between px-6 pt-5"> … </div>
  {/* scroll body, centered column */}
  <div className="flex-1 overflow-y-auto">
    <div className="mx-auto flex max-w-[720px] flex-col gap-6 px-6 py-7"> … <div ref={endRef}/> </div>
  </div>
</div>
```
Auto-scroll: `useEffect(() => endRef.current?.scrollIntoView({behavior:'smooth',block:'end'}), [deps])`.

**Panel (the "Ingesting" card is the template)**
```tsx
<motion.section initial={{opacity:0,y:8}} animate={{opacity:1,y:0}} className="glass rounded-2xl p-4">
  <div className="flex items-center gap-2.5">
    <span className="grid size-8 place-items-center rounded-lg bg-ink text-white">
      <Icon className="size-[17px]" strokeWidth={2}/>
    </span>
    <div className="min-w-0">
      <div className="text-[14px] font-medium text-ink">Title</div>
      <div className="text-[12px] text-muted">subtitle</div>
    </div>
    {done ? <Check className="ml-auto size-4 text-sage-600" strokeWidth={2.5}/>
          : <Loader2 className="ml-auto size-4 animate-spin text-sage-500" strokeWidth={2.25}/>}
  </div>
  {/* streamed rows below */}
</motion.section>
```

**Streamed row (nodes/sources appear like this)**
```tsx
<motion.div layout initial={{opacity:0,x:-6}} animate={{opacity:1,x:0}}
  className="flex items-center gap-2.5 rounded-xl bg-white/45 px-3 py-2 ring-1 ring-inset ring-black/[0.04]">
  <PlatformIcon platform={p} size={20}/>
  <span className="text-[13px] text-ink">Label</span>
  <span className="truncate text-[12px] text-faint">sublabel</span>
  <span className="ml-auto shrink-0 text-[12px] tabular-nums text-muted">42 nodes</span>
  <Check className="size-3.5 text-sage-600" strokeWidth={2.5}/>
</motion.div>
```

**Card (gap card / candidate card)**: `glass rounded-xl p-3.5`, `motion layout initial={{opacity:0,y:8}}`.

**Section label**: `text-[12px] font-medium uppercase tracking-[0.1em] text-faint`.

**Status pills**: auto/good → `bg-sage-500/14 text-sage-700`; gated/warn → `bg-amber-400/18 text-amber-500`
(prefix `<ShieldAlert className="size-3" strokeWidth={2.25}/>`).

**Header pill button**:
```tsx
className="flex items-center gap-1.5 rounded-full border border-black/[0.06] bg-white/40 px-3 py-1.5 text-[13px] text-muted transition-colors hover:bg-white/70 hover:text-ink"
```

**Narration line** (thinking): `flex items-center gap-2 text-[13.5px] text-muted` + `<Sparkles className="size-3.5 text-sage-500"/>` + `<span className="italic">…`.

**Citations row**:
```tsx
<span className="flex items-center gap-1.5 text-[12px] text-muted">
  <PlatformIcon platform={cit.sourcePlatform} size={14}/>
  <span className="font-medium text-ink/75">{cit.author}</span>
  <span className="text-faint">{shortDate(cit.timestamp)}</span>
</span>
```

**Tokens** (from `index.css @theme`): canvas `#f4f2ec`, ink `#1c1d18`, muted `#6f7268`, faint
`#a2a498`; sage 50→700 (accent, `--color-sage-500 #3f7d5c`), amber-400 `#dca059`, amber-500
`#c67f3d`, clay-500 `#b4623f`. `glass` is an existing utility class. Fonts: `font-serif`
(Instrument Serif) for big headings, `font-sans` (Inter) default. Use `tabular-nums` for counts.

**Motion**: framer-motion everywhere; view transitions use `AnimatePresence mode="wait"` +
`initial/animate/exit opacity` (see `App.tsx:180`).

---

## 5. New files + types

```
web/src/lib/
  projectTypes.ts     # types below
  projectMock.ts      # demo project (CBX2/tau): sources, pre-extracted nodes/edges, precomputed embeddings
  projectStore.ts     # buildGraph() async generator (mirror autopilot.ts) + project CRUD (local, mirror local.ts)
  gapEngine.ts        # 4 signals + rankGaps() — pure functions
  exaAugment.ts       # sufficiencyGate() + expandViaExa() (mock default, live behind flag)
  graphLayout.ts      # useForceLayout() hook wrapping d3-force-3d + streaming reheat

web/src/components/projects/
  ProjectsView.tsx    # list <-> detail switch (mounted by App)
  ProjectList.tsx     # project cards + New project
  ProjectDetail.tsx   # composes dropzone + graph + gap panel + run + slack
  SourceDropzone.tsx  # add papers, attribution badges, sufficiency gate, "Create Graph"
  BuildStream.tsx     # the streamed build panel (mirrors IngestPanel) consuming buildGraph()
  KnowledgeGraph3D.tsx# <Canvas> + nodes + edges + Bloom + OrbitControls
  GraphPrimitives.tsx # <NodeMesh> + <EdgeLine> (color by kind/relation/state)
  GapPanel.tsx        # ranked cited gaps + "Run this now"
  RunResultCard.tsx   # grounded result; fires edge-resolve
  SlackDraftBubble.tsx# grounded conversational draft -> Send (PendingAction reuse)
```

**`projectTypes.ts`**
```ts
import type { Citation, Person, SourcePlatform } from './types'

export interface PaperSource {
  id: string
  title: string
  paperAuthors: string       // e.g. "Chen et al." (the PAPER's authors, not lab)
  venue?: string; year?: number; doi?: string
  addedBy: { kind: 'human'; person: Person } | { kind: 'exa' }
  validated?: boolean        // passed the quality filter
}

export type GraphNodeKind =
  | 'Gene' | 'Protein' | 'Hypothesis' | 'Method' | 'Result' | 'Assay' | 'Compound' | 'Phenotype'

export interface GraphNode {
  id: string
  label: string
  kind: GraphNodeKind
  sources: string[]          // PaperSource ids
  contributors: string[]     // Person ids ('exa' allowed) — for honest attribution
  confidence: number         // 0..1
  embedding?: number[]       // mock: precomputed; prod: Voyage
  x?: number; y?: number; z?: number  // filled by d3-force-3d
}

export type Relation =
  | 'activates' | 'inhibits' | 'binds' | 'regulates' | 'associated' | 'method_for' | 'measures'

export type EdgeState = 'asserted' | 'predicted' | 'contradiction' | 'confirmed' | 'refuted'

export interface GraphEdge {
  id: string
  source: string; target: string
  relation: Relation
  state: EdgeState           // drives color (see §7)
  sources: string[]
  confidence: number
}

export type GapKind = 'open_triad' | 'link_prediction' | 'contradiction' | 'fragile'

export interface Gap {
  id: string
  kind: GapKind
  title: string              // "CBX2 → tau aggregation is untested"
  rationale: string
  score: number              // novelty × plausibility × testability, 0..1
  subgraph: { nodes: string[]; edges: string[] }  // highlight on click
  citations: Citation[]      // the bridging papers
  proposedRun: { mode: 'compute' | 'wetlab'; label: string }
}

export interface Project {
  id: string
  title: string
  question: string
  createdBy: Person
  sources: PaperSource[]
  nodes: GraphNode[]
  edges: GraphEdge[]
  gaps: Gap[]
}
```

**Build event union** (`projectStore.ts` — mirror `AutopilotEvent`)
```ts
export type GraphBuildEvent =
  | { type: 'sufficiency'; have: number; need: number; ok: boolean }
  | { type: 'augment:start' }
  | { type: 'augment:source'; source: PaperSource }   // Exa-found, validated
  | { type: 'augment:done'; added: number }
  | { type: 'extract:paper'; sourceId: string; title: string }
  | { type: 'graph:node'; node: GraphNode }
  | { type: 'graph:edge'; edge: GraphEdge }
  | { type: 'graph:settled'; nodes: number; edges: number }
  | { type: 'think'; text: string }
  | { type: 'gaps'; items: Gap[] }
  | { type: 'done' }

export async function* buildGraph(project: Project, signal?: AbortSignal): AsyncGenerator<GraphBuildEvent>
```
Use the exact `sleep(ms, signal)` helper from `autopilot.ts:45`. Pace: augment sources ~430ms
apart, nodes ~90–140ms apart (fast enough to feel alive, slow enough to watch bloom), a couple of
`think` lines, then `gaps`.

---

## 6. Gap engine (`gapEngine.ts`) — the moat, keep it real

Pure functions over `nodes` + `edges`. Four signals, each returns `Gap[]`:

```ts
detectOpenTriads(nodes, edges): Gap[]
  // A—B and B—C exist, A—C absent. kind:'open_triad'. Swanson ABC linking.
scoreLinkPrediction(nodes, edges): Gap[]
  // cosine over node.embedding for non-adjacent pairs; top-K above threshold. kind:'link_prediction'.
detectContradictions(edges): Gap[]
  // same (source,target) unordered pair with conflicting relation (activates vs inhibits). kind:'contradiction'.
detectFragile(edges): Gap[]
  // edge asserted by a single low-confidence source. kind:'fragile'.

rankGaps(all: Gap[]): Gap[]
  // score = novelty(0..1) × plausibility(0..1) × testability(0..1); sort desc; dedupe by node-pair.
```

Each gap MUST carry `citations` (the bridging papers) and a `subgraph` to highlight. For the demo,
`projectMock` ships precomputed `embedding` vectors so `scoreLinkPrediction` is real math, not a stub.
Say the method out loud in UI copy: *"open A–B–C triad · link-pred 0.81 · bridged by Chen 2021,
Okafor 2023 · testable via co-IP."*

---

## 7. 3D graph (SOTA decision + how)

**Decision:** do NOT add a separate-canvas graph lib (react-force-graph / cosmograph / reagraph all
spawn their own WebGL context and clash with r3f). Instead reuse your r3f stack (proven in
`Deck3D.tsx`):

- **Layout:** `d3-force-3d` computes 3D positions in `useForceLayout`.
- **Render:** hand-rolled r3f nodes/edges in one `<Canvas>`.
- **Glow:** `@react-three/postprocessing` `<EffectComposer><Bloom/></EffectComposer>`.
- **Camera:** drei `OrbitControls` (copy from `Deck3D`).

**Deps to add (additive):**
```
npm i d3-force-3d @react-three/postprocessing
npm i -D @types/d3-force-3d
```
Confirm `@react-three/postprocessing` resolves against three 0.185 / r3f 9 (`npm ls three`). If it
balks, **fallback**: skip postprocessing, fake glow with `meshBasicMaterial` emissive cores +
additive-blend sprite halos (`THREE.AdditiveBlending`). Bloom is a nice-to-have, not load-bearing.

**`graphLayout.ts`**
```ts
import { forceSimulation, forceLink, forceManyBody, forceCenter } from 'd3-force-3d'
// useForceLayout(nodes, edges): returns a ref to live positions + a version counter.
// On new nodes appended: sim.nodes(nodes); sim.force('link').links(edges); sim.alpha(0.8).restart()
//   -> reheat -> nodes settle -> the bloom-in animation. Read x/y/z each frame in useFrame.
```
Positions are mutated by the sim; read them in `useFrame` and lerp meshes toward them (same trick as
`Deck3D`'s gantry lerp) so movement is smooth, not jumpy.

**Node color by kind** (use tokens): Gene `sage-500`, Protein `clay-500`, Hypothesis `amber-500`,
Method `muted`, Result `sage-700`, Assay `sage-400`, Compound `amber-400`, Phenotype `ink`.
Node radius ∝ `confidence` or degree.

**Edge color by `state`**: `asserted` `rgba(28,29,24,0.28)`; `predicted` `amber-400` **dashed**;
`contradiction` `#d05a4a`; `confirmed` `sage-500`; `refuted` `#d05a4a` (add a quick shake/crack).

**Interaction:** hover node → tooltip (label, kind, sources, contributors); click gap in `GapPanel`
→ raise opacity of `gap.subgraph` nodes/edges, dim the rest.

**Perf:** cap demo graph ~120–150 nodes for buttery bloom. If you go bigger, use
`InstancedMesh` for nodes. Keep DPR capped (`<Canvas dpr={[1, 1.75]}>`).

---

## 8. Consuming the build stream (mirror `RunView.consume`)

`BuildStream` (or `ProjectDetail`) holds a phase machine and consumes `buildGraph` exactly like
`RunView`:
```ts
type Phase = 'idle' | 'checking' | 'augmenting' | 'extracting' | 'settling' | 'gaps' | 'done'
// useEffect on a runToken; AbortController; for await (ev of buildGraph(project, signal)) { switch(ev.type) … }
// graph:node -> append to nodes state (feeds useForceLayout -> bloom)
// graph:edge -> append to edges state
// gaps       -> setGaps(ev.items); phase='gaps'
// Mount once, stable key, so an in-flight build survives nav (same rule as RunView / the Composer).
```
`exaAugment.ts`: `sufficiencyGate(sources) -> {ok, need}`; if `!ok`, `expandViaExa(seedEntities, need)`
returns validated `PaperSource[]` with `addedBy:{kind:'exa'}`. Mock returns deterministic extras;
live path (behind `VITE_CLAYMORE_LIVE`) calls Exa.

---

## 9. The exactly-3 wiring edits (only touches to existing files)

1. **`lib/types.ts`** — add `| 'projects'` to the `View` union (line 10).
2. **`components/Sidebar.tsx`** — one entry in `NAV` (after `ask`), e.g.
   `{ view: 'projects', label: 'Projects', icon: FolderGit2 }` (import `FolderGit2` from `lucide-react`).
3. **`App.tsx`** — one import `import { ProjectsView } from '@/components/projects/ProjectsView'`
   and one `case 'projects': return <ProjectsView />` inside `renderOther()` (the `switch (view)` at
   line 109). (Projects has no right rail, so leave `showRail`/`SourceRail` alone — it's `view==='ask'` only.)

Nothing else in those files changes.

---

## 10. Build order (one week) + acceptance

1. **Scaffold + wiring (0.5d).** `projectTypes.ts`, `projectMock.ts` (CBX2/tau corpus with
   precomputed embeddings), `ProjectsView`/`ProjectList`/`ProjectDetail` shells, the 3 wiring edits.
   *Accept:* Projects tab appears, lists the demo project, opens detail.
2. **3D graph (2d — invest, it's the visual moat).** `graphLayout.ts`, `KnowledgeGraph3D`,
   `GraphPrimitives`, Bloom, OrbitControls, fed by `projectMock`. *Accept:* graph renders, orbits,
   nodes colored by kind, edges by state; looks premium.
3. **Build stream (1d).** `projectStore.buildGraph`, `BuildStream` consuming it, streaming node
   bloom. *Accept:* Create Graph animates the graph assembling in, matching the ingest-panel look.
4. **Sufficiency gate + Exa (1d).** `exaAugment` (mock), `SourceDropzone` with attribution badges.
   *Accept:* adding <6 sources then Create Graph shows the augment step add validated Exa sources,
   marked distinctly; graph builds from the union.
5. **Gap engine + panel (1d).** `gapEngine` (4 signals), `GapPanel` ranked + cited, click-to-highlight
   subgraph. *Accept:* gaps are real (open triads + link-pred over mock embeddings), each cites papers,
   clicking one highlights its subgraph in 3D.
6. **Run + resolve (1d).** Wire **Run this now** into the existing run machinery (`experiment()` +
   `AgentTurn` + `AnswerView`); `RunResultCard`; animate the edge `predicted`→`confirmed`/`refuted`.
   *Accept:* running a gap streams a trace and flips its edge with animation.
7. **Slack close + polish (0.5d).** `SlackDraftBubble` grounded draft → Send (PendingAction reuse);
   pre-warm/caching for the demo; responsive + motion polish. *Accept:* full loop demoable in ~90s.

---

## 11. Gotchas

- **Latency is the show, not the enemy.** Real extraction is slow; stream nodes as they resolve and
  run Exa in parallel. Cache the built demo project so a re-run is instant if the live build lags.
  Keep a pre-warmed fallback for stage.
- **Keep the live seam.** Default to mock (`isLive`/`VITE_CLAYMORE_LIVE`), so the demo never depends
  on network/keys. Exa credits can run out (they did during planning) — mock must stand alone.
- **Honest attribution** everywhere: Exa sources are `addedBy:'exa'`, visibly distinct. Don't let a
  node claim a human contributor it doesn't have.
- **Wet-lab stays gated + simulated.** Route `proposedRun.mode==='wetlab'` to the Opentrons sim +
  approval, never a fake physical run. Reads as responsible science (Gladstone likes this).
- **Don't disturb teammates.** Branch off `d347dd2`; only the 3 wiring lines touch shared files.
- **3D perf:** cap nodes ~150, cap DPR, use InstancedMesh if scaling. Dispose geometries on unmount.
- **Type re-use, not re-def:** import `Citation`/`Person` from `lib/types.ts`; extend by composition.

---

## 12. Demo choreography (the 90 seconds)

1. Open project "CBX2 / tau regulation" (corpus pre-ingested for speed).
2. Show 3 seed papers with **who added each**. Hit **Create Graph**.
3. Sufficiency gate: "3 < 6 — sourcing validated papers" → 3 Exa papers stream in, marked auto.
4. 3D graph **blooms** into clusters (the gasp).
5. Gap panel: **"3 gaps found."** Top = an open triad, score + bridging citations.
6. Click it → the exact **subgraph + 2 papers** light up (evidence, not magic).
7. **Run this now** → compute path (Claude Science) streams a trace → result.
8. The dashed-gold edge **snaps green**; `RunResultCard` shows the finding.
9. **SlackDraftBubble** pops, pre-filled and grounded → hit **Send** → posts to the lab.
10. Closing line on screen: *"This link is now supported. 2 downstream hypotheses just became
    testable."*

---

*End of build doc. Start at §10 step 1.*
