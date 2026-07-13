/**
 * A small, coherent lab corpus so the UI feels alive without a backend. Every
 * answer is grounded in these sources and cited — mirroring the real Ask loop's
 * anti-fabrication rule (ungrounded question -> honest no-answer).
 *
 * The narrative: a structural-biology lab working on the CBX2 protein. Last week
 * Lucas suggested probing an allosteric pocket; Maya's buffer doc warns about
 * DMSO; the Tuesday sync prioritized the docking pipeline; Rikhin asked whether
 * the "Y hypothesis" was ever tested. Those threads connect across sources.
 */
import type {
  Connector,
  Entity,
  LabNotification,
  Person,
  Reply,
  SourceFeed,
} from './types'

const NOW = new Date()

function daysAgo(days: number, hour = 10, min = 0): string {
  const d = new Date(NOW)
  d.setDate(d.getDate() - days)
  d.setHours(hour, min, 0, 0)
  return d.toISOString()
}

export const people: Person[] = [
  { id: 'lucas', name: 'Lucas Meyer', role: 'Postdoc', accent: '#3f7d5c', avatar: '/people/lucas.jpg' },
  { id: 'philip', name: 'Philip Zhao', role: 'PhD · pipelines', accent: '#4a6fa5', avatar: '/people/philip.jpg' },
  { id: 'maya', name: 'Maya Okonkwo', role: 'Research scientist', accent: '#b4623f', avatar: '/people/maya.jpg' },
  { id: 'rikhin', name: 'Rikhin', role: 'PI', accent: '#7a5ea8', avatar: '/people/rikhin.jpg' },
  { id: 'sofia', name: 'Sofia Reyes', role: 'Collaborator · MIT', accent: '#c67f3d', avatar: '/people/sofia.jpg' },
]

/** Portrait photo for a message author's display name (feeds show real faces, not initials). */
export function photoForAuthor(name?: string): string | undefined {
  if (!name) return undefined
  return people.find((p) => p.name === name)?.avatar
}

export const exampleQueries: string[] = [
  'What did Lucas suggest last week about the X protein?',
  "What did we decide in Tuesday's sync?",
  'Did we ever test the Y hypothesis?',
  'There was a doc about the assay buffer — what did it say?',
]

/* ------------------------------------------------------------------ feeds -- */

export const feeds: SourceFeed[] = [
  {
    platform: 'slack',
    title: '#protein-eng',
    subtitle: '8 members',
    connected: true,
    lastSync: daysAgo(0, 9, 12),
    messages: [
      {
        id: 'sl1',
        author: 'Lucas Meyer',
        accent: '#3f7d5c',
        timestamp: daysAgo(6, 15, 41),
        text: "Been staring at the CBX2 thermal-shift traces again — I'm now pretty sure the DMSO is the confounder, not the compound. What if we probe the allosteric pocket instead of the canonical site? Might explain the flat ΔTm.",
        extracted: true,
        reactions: [
          { emoji: '❤️', count: 2 },
          { emoji: '👀', count: 1 },
        ],
        replies: {
          count: 3,
          by: [
            { name: 'Maya Okonkwo', accent: '#b4623f' },
            { name: 'Philip Zhao', accent: '#4a6fa5' },
            { name: 'Sofia Reyes', accent: '#c67f3d' },
          ],
        },
      },
    ],
  },
  {
    platform: 'imessage',
    title: 'Rikhin',
    subtitle: 'PI',
    connected: true,
    lastSync: daysAgo(0, 8, 30),
    messages: [
      {
        id: 'im1',
        author: 'Rikhin',
        accent: '#7a5ea8',
        timestamp: daysAgo(1, 20, 14),
        text: 'did we ever actually run the Y-hypothesis control on CBX2?',
        bubble: 'in',
        extracted: true,
      },
      {
        id: 'im2',
        author: 'You',
        timestamp: daysAgo(1, 20, 15),
        text: 'checking claymore now 👀',
        bubble: 'out',
      },
    ],
  },
  {
    platform: 'notion',
    title: 'Assay Buffer v3',
    subtitle: 'Protocols / DSF',
    connected: true,
    lastSync: daysAgo(0, 7, 2),
    messages: [
      {
        id: 'nt1',
        author: 'Maya Okonkwo',
        accent: '#b4623f',
        timestamp: daysAgo(64, 11, 5),
        text: '50 mM HEPES pH 7.5 · 150 mM NaCl · 1 mM TCEP · 5% glycerol. Keep DMSO < 2% — above that the thermal-shift baseline drifts and ΔTm is unreliable.',
        extracted: true,
        attachment: { label: 'CBX2_DSF_SOP.pdf', kind: 'gdrive' },
      },
    ],
  },
  {
    platform: 'gmail',
    title: 'Sofia Reyes',
    subtitle: 'CBX2 crystal soaks',
    connected: true,
    lastSync: daysAgo(0, 6, 40),
    messages: [
      {
        id: 'gm1',
        author: 'Sofia Reyes',
        handle: 'sofia.reyes@scripps.edu',
        accent: '#c67f3d',
        timestamp: daysAgo(3, 9, 3),
        text: 'Sending over the soak conditions that worked for the allosteric fragment — 10 mM in the mother liquor, 4 h. Happy to co-author if the docking pans out.',
        extracted: true,
      },
    ],
  },
  {
    platform: 'github',
    title: 'claymore/docking-pipeline',
    subtitle: 'main',
    connected: true,
    lastSync: daysAgo(0, 9, 55),
    messages: [
      {
        id: 'gh1',
        author: 'Philip Zhao',
        accent: '#4a6fa5',
        timestamp: daysAgo(4, 14, 22),
        text: 'prep CBX2 allosteric site + grid box',
        extracted: true,
        attachment: { label: '3f2c1ab', kind: 'github' },
      },
      {
        id: 'gh2',
        author: 'Philip Zhao',
        accent: '#4a6fa5',
        timestamp: daysAgo(2, 16, 9),
        text: 'add DMSO-tolerance flag to scoring function',
        attachment: { label: 'a91be40', kind: 'github' },
      },
    ],
  },
]

/* --------------------------------------------------------------- answers -- */

export const CIT = {
  lucasSlack: {
    sourcePlatform: 'slack' as const,
    sourceId: 'protein-eng/1718900000.041',
    author: 'Lucas Meyer',
    timestamp: daysAgo(6, 15, 41),
    sourceLabel: '#protein-eng',
    quote:
      'What if we probe the allosteric pocket instead of the canonical site? Might explain the flat ΔTm.',
  },
  lucasSlack2: {
    sourcePlatform: 'slack' as const,
    sourceId: 'protein-eng/1718900520.052',
    author: 'Lucas Meyer',
    timestamp: daysAgo(6, 15, 52),
    sourceLabel: '#protein-eng',
    quote: 'if the Y hypothesis holds, allosteric engagement should rescue the shift.',
  },
  granola: {
    sourcePlatform: 'granola' as const,
    sourceId: 'granola/tue-roundup-0af2',
    author: 'Lab roundup',
    timestamp: daysAgo(2, 11, 0),
    sourceLabel: 'Tuesday sync',
    quote:
      'Decision: prioritize the docking pass on the CBX2 allosteric site before any more wet-lab; revisit the buffer once DMSO tolerance is confirmed.',
  },
  rikhinImsg: {
    sourcePlatform: 'imessage' as const,
    sourceId: 'imsg/rikhin/8821',
    author: 'Rikhin',
    timestamp: daysAgo(1, 20, 14),
    sourceLabel: 'DM',
    quote: 'did we ever actually run the Y-hypothesis control on CBX2?',
  },
  mayaNotion: {
    sourcePlatform: 'notion' as const,
    sourceId: 'notion/assay-buffer-v3',
    author: 'Maya Okonkwo',
    timestamp: daysAgo(64, 11, 5),
    sourceLabel: 'Assay Buffer v3',
    quote: 'Keep DMSO < 2% — above that the thermal-shift baseline drifts and ΔTm is unreliable.',
  },
  philipCommit: {
    sourcePlatform: 'github' as const,
    sourceId: 'claymore/docking-pipeline@3f2c1ab',
    author: 'Philip Zhao',
    timestamp: daysAgo(4, 14, 22),
    sourceLabel: 'docking-pipeline',
    quote: 'prep CBX2 allosteric site + grid box',
  },
  sofiaGmail: {
    sourcePlatform: 'gmail' as const,
    sourceId: 'gmail/CBX2-soaks-19a2',
    author: 'Sofia Reyes',
    timestamp: daysAgo(3, 9, 3),
    sourceLabel: 'CBX2 crystal soaks',
    quote: '10 mM in the mother liquor, 4 h — worked for the allosteric fragment.',
  },
}

interface Canned {
  match: RegExp
  reply: Reply
}

const CANNED: Canned[] = [
  // --- Proactive nudges: "Ask about this" routes here for a grounded, cited answer.
  //     Listed first so they win over the generic topic matches below. ---
  {
    match: /never tested|untested|what would it take to run|what.?s blocking/i,
    reply: {
      text: "That's Lucas's allosteric-pocket idea for CBX2 from last week — it has never been run. To run it: use the grid box Philip already prepped in docking-pipeline (commit 3f2c1ab) with Maya's <2% DMSO buffer (Assay Buffer v3), then dock the fragment library into the allosteric site. The only blocker is that the setup exists but no production run is logged — queue the docking pass and it's unblocked.",
      scopeLabel: 'last week',
      citations: [CIT.lucasSlack2, CIT.philipCommit, CIT.mayaNotion],
      pendingAction: {
        token: 'A3',
        kind: 'file_issue',
        description: 'File an issue on claymore/docking-pipeline',
        target: 'claymore/docking-pipeline',
        preview:
          'Run the allosteric-pocket docking pass on CBX2\n\nSetup exists (grid box 3f2c1ab) but no run is logged. Dock the fragment library into the allosteric site with the <2% DMSO buffer (Assay Buffer v3). Proposed by Lucas; the blocker is execution, not setup.',
      },
    },
  },
  {
    match: /superseded|reconcile|which is (the )?current/i,
    reply: {
      text: "Two decisions conflict. The Tuesday sync deprioritized wet-lab until DMSO tolerance is confirmed; Sofia's email a few days earlier proposes crystal soaks now. The Tuesday sync is the more recent lab-wide decision, so it's the current one — hold Sofia's soaks until DMSO tolerance is confirmed on the docking side, then revisit her conditions. Worth telling Sofia so she isn't left blocked.",
      scopeLabel: 'this week',
      citations: [CIT.granola, CIT.sofiaGmail],
      pendingAction: {
        token: 'A4',
        kind: 'draft_reply',
        description: 'Reply to Sofia in Gmail',
        target: 'Sofia Reyes',
        preview:
          "Thanks Sofia — love the soak conditions. We deprioritized wet-lab in Tuesday's sync until we confirm DMSO tolerance on the docking side; once that's in (this week) we'll queue your 10 mM / 4 h soak. Will loop you in.",
      },
    },
  },
  {
    match: /thursday brief|expand on the thursday|what moved on cbx2/i,
    reply: {
      text: 'This week on CBX2: Lucas proposed the allosteric-pocket hypothesis, Philip prepped the docking site + grid box (and added a DMSO-tolerance flag), Sofia sent crystal-soak conditions, and Rikhin asked whether the Y-hypothesis control was ever run — it wasn’t. The one open thread is queuing that docking pass; everything else is set up and waiting on it.',
      scopeLabel: 'this week',
      citations: [CIT.lucasSlack, CIT.philipCommit, CIT.rikhinImsg],
    },
  },
  {
    match: /lucas|suggest|allosteric|(x |the )protein|cbx2/i,
    reply: {
      text: "Last week in #protein-eng, Lucas Meyer suggested probing CBX2's allosteric pocket rather than the canonical site. His reasoning: the flat ΔTm in the thermal-shift assay is likely a DMSO artifact, not a real lack of binding — and if the Y hypothesis holds, allosteric engagement should rescue the shift. He proposed a docking pass before spending more protein.",
      scopeLabel: 'last week',
      citations: [CIT.lucasSlack, CIT.lucasSlack2],
      pendingAction: {
        token: 'A1',
        kind: 'draft_reply',
        description: 'Reply to Lucas in #protein-eng',
        target: '#protein-eng',
        preview:
          "Following up on your allosteric idea — Philip already prepped the CBX2 allosteric site + grid box in docking-pipeline, and the Tuesday sync prioritized this pass. Want me to queue the run with Maya's <2% DMSO buffer?",
      },
    },
  },
  {
    match: /tuesday|sync|roundup|round-up|decide|decided|meeting|standup/i,
    reply: {
      text: 'In the Tuesday sync, the lab decided to prioritize the docking pass on the CBX2 allosteric site before any more wet-lab work, and to revisit the assay buffer once DMSO tolerance is confirmed. This directly followed Lucas’s allosteric suggestion from last week.',
      scopeLabel: "this week · Tuesday's sync",
      citations: [CIT.granola, CIT.lucasSlack],
    },
  },
  {
    match: /y hypothesis|ever test|ever run|already (test|run)|tested|control/i,
    reply: {
      text: "Not yet — there's no record of the Y-hypothesis control actually being run on CBX2. Rikhin asked the same thing yesterday, and the closest work is Philip's docking-pipeline commit prepping the allosteric site (setup only, no run logged). The idea traces back to Lucas's suggestion last week. It's a good candidate to queue.",
      scopeLabel: 'all time',
      citations: [CIT.rikhinImsg, CIT.philipCommit, CIT.lucasSlack2],
      pendingAction: {
        token: 'A2',
        kind: 'file_issue',
        description: 'File an issue on claymore/docking-pipeline',
        target: 'claymore/docking-pipeline',
        preview:
          'Run Y-hypothesis control on CBX2 allosteric site\n\nNever executed (confirmed via memory). Use the prepped grid box from 3f2c1ab and the <2% DMSO buffer (Assay Buffer v3). Requested by Rikhin, originally proposed by Lucas.',
      },
    },
  },
  {
    match: /buffer|dmso|assay|recipe|hepes|doc about|random doc/i,
    reply: {
      text: 'That’s Maya’s "Assay Buffer v3" doc in Notion (~2 months ago). Recipe: 50 mM HEPES pH 7.5, 150 mM NaCl, 1 mM TCEP, 5% glycerol. The key warning: keep DMSO under 2% — above that the thermal-shift baseline drifts and ΔTm becomes unreliable. That’s the same DMSO confound Lucas flagged for CBX2.',
      scopeLabel: 'a couple months ago',
      citations: [CIT.mayaNotion, CIT.lucasSlack],
    },
  },
  {
    match: /docking|pipeline|latest|status|progress|philip/i,
    reply: {
      text: "Latest on the docking pipeline: Philip prepped the CBX2 allosteric site and grid box (4 days ago), then added a DMSO-tolerance flag to the scoring function (2 days ago). No production run is logged yet. The Tuesday sync made this the priority before more wet-lab.",
      scopeLabel: 'recently',
      citations: [CIT.philipCommit, CIT.granola],
    },
  },
  {
    match: /crystal|soak|sofia|co-?author|fragment/i,
    reply: {
      text: 'Sofia Reyes (MIT) emailed the crystal-soak conditions for the allosteric fragment 3 days ago: 10 mM in the mother liquor for 4 hours. She offered to co-author if the docking pans out.',
      scopeLabel: 'this week',
      citations: [CIT.sofiaGmail],
    },
  },
]

const NO_ANSWER: Reply = {
  text: "I couldn't find anything about that in the lab's memory. Try asking about the CBX2 protein, the assay buffer, the docking pipeline, or the Tuesday sync.",
  citations: [],
}

/** Match a query to a grounded answer, or an honest no-answer (like the real loop). */
export function answerFor(query: string): Reply {
  const q = query.trim()
  if (!q) return NO_ANSWER
  for (const c of CANNED) {
    if (c.match.test(q)) return c.reply
  }
  return NO_ANSWER
}

/* -------------------------------------------------- other-view mock data -- */

export const notifications: LabNotification[] = [
  {
    id: 'n1',
    kind: 'never_tested',
    title: 'An idea from last week was never tested',
    body: "Lucas's allosteric-pocket hypothesis for CBX2 was suggested 6 days ago but has no logged experiment. Philip prepped the site but no run exists.",
    priority: 'normal',
    timestamp: daysAgo(0, 8, 0),
    citations: [CIT.lucasSlack2, CIT.philipCommit],
  },
  {
    id: 'n2',
    kind: 'contradiction',
    title: 'A decision may have been superseded',
    body: 'The Tuesday sync deprioritized wet-lab until DMSO tolerance is confirmed, but Sofia’s email proposes crystal soaks now. Worth reconciling.',
    priority: 'high',
    timestamp: daysAgo(0, 8, 30),
    citations: [CIT.granola, CIT.sofiaGmail],
  },
  {
    id: 'n3',
    kind: 'digest',
    title: 'Your Thursday brief',
    body: '3 threads moved on CBX2 this week: allosteric suggestion (Lucas), docking prep (Philip), soak conditions (Sofia). One open question from Rikhin.',
    priority: 'low',
    timestamp: daysAgo(0, 7, 15),
    citations: [CIT.lucasSlack, CIT.philipCommit, CIT.rikhinImsg],
  },
]

export const connectors: Connector[] = [
  { platform: 'slack', name: 'Slack', connected: true, account: 'claymore-lab.slack.com', lastSync: daysAgo(0, 9, 12), episodes: 1284 },
  { platform: 'gmail', name: 'Gmail', connected: true, account: 'lab@claymore.bio', lastSync: daysAgo(0, 6, 40), episodes: 512 },
  { platform: 'github', name: 'GitHub', connected: true, account: 'claymore-lab', lastSync: daysAgo(0, 9, 55), episodes: 968 },
  { platform: 'notion', name: 'Notion', connected: true, account: 'Claymore Lab', lastSync: daysAgo(0, 7, 2), episodes: 226 },
  { platform: 'imessage', name: 'iMessage', connected: true, account: 'BlueBubbles bridge', lastSync: daysAgo(0, 8, 30), episodes: 143 },
  { platform: 'granola', name: 'Granola', connected: true, account: 'Business', lastSync: daysAgo(2, 11, 0), episodes: 47 },
  { platform: 'zoom', name: 'Zoom', connected: true, account: 'claymore-lab.zoom.us', lastSync: daysAgo(0, 5, 48), episodes: 112 },
  { platform: 'gdrive', name: 'Google Drive', connected: false },
  { platform: 'codelogs', name: 'Claude Code logs', connected: false },
]

export const entities: Entity[] = [
  { id: 'e1', name: 'CBX2', kind: 'Protein', mentions: 38, lastTouched: daysAgo(1) },
  { id: 'e2', name: 'Allosteric pocket', kind: 'Hypothesis', mentions: 12, lastTouched: daysAgo(1) },
  { id: 'e3', name: 'Thermal-shift assay', kind: 'Assay', mentions: 21, lastTouched: daysAgo(2) },
  { id: 'e4', name: 'Assay Buffer v3', kind: 'Protocol', mentions: 9, lastTouched: daysAgo(3) },
  { id: 'e5', name: 'docking-pipeline', kind: 'Dataset', mentions: 27, lastTouched: daysAgo(2) },
  { id: 'e6', name: 'Y hypothesis', kind: 'Hypothesis', mentions: 6, lastTouched: daysAgo(1) },
]
