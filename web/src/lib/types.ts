/**
 * UI domain types. These deliberately mirror the Claymore backend shapes so the
 * mock layer and a real `/api/ask` response are interchangeable:
 *   - Reply / Citation      -> src/claymore/agent/__init__.py
 *   - SourcePlatform        -> src/claymore/domain.py  (+ 'imessage' for this UI)
 *   - PendingAction / kinds -> src/claymore/actions/approvals.py
 */

/** Top-level views selectable from the left sidebar. */
export type View = 'ask' | 'bench' | 'memory' | 'approvals' | 'connectors' | 'proactive'

export type SourcePlatform =
  | 'slack'
  | 'gmail'
  | 'github'
  | 'notion'
  | 'gdrive'
  | 'gdocs'
  | 'granola'
  | 'codelogs'
  | 'imessage'
  | 'manual'

/** The attributed source behind a claim (platform + id + author + when). */
export interface Citation {
  sourcePlatform: SourcePlatform
  sourceId: string
  author: string
  timestamp: string // ISO 8601
  quote?: string
  sourceLabel?: string // "#protein-eng", "DM", repo name…
}

export type ActionKind =
  | 'draft_reply'
  | 'file_issue'
  | 'create_page'
  | 'make_link'
  | 'post_result'
  | 'run_compute'
  | 'propose_protocol'
  | 'physical_run'

/** A proposed write-back awaiting one-tap human approval ("you just approve"). */
export interface PendingAction {
  token: string
  kind: ActionKind
  description: string
  target: string // e.g. "#protein-eng", "claymore/docking-pipeline"
  preview: string // the drafted body / issue text
}

/** The agent's answer to a question. */
export interface Reply {
  text: string
  citations: Citation[]
  pendingAction?: PendingAction | null
  /** Resolved temporal scope echoed back, e.g. "last week (Jun 30 – Jul 6)". */
  scopeLabel?: string
}

/* ---- right-rail source feeds (recreated Slack / iMessage / Notion / …) ---- */

export interface SourceMessage {
  id: string
  author: string
  handle?: string
  accent?: string // avatar / bubble tint
  timestamp: string
  text: string
  /** Claymore has extracted this episode into memory. */
  extracted?: boolean
  /** iMessage bubble direction. */
  bubble?: 'in' | 'out'
  /** small inline attachment chip, e.g. a linked doc / commit. */
  attachment?: { label: string; kind: SourcePlatform }
}

export interface SourceFeed {
  platform: SourcePlatform
  title: string // "#protein-eng", "Rikhin", "Assay Buffer v3"
  subtitle?: string
  connected: boolean
  lastSync?: string
  messages: SourceMessage[]
}

/* ---- other views (Approvals / Proactive / Connectors / Memory) ---- */

export type NotificationKind = 'never_tested' | 'contradiction' | 'digest'

export interface LabNotification {
  id: string
  kind: NotificationKind
  title: string
  body: string
  priority: 'low' | 'normal' | 'high'
  timestamp: string
  citations: Citation[]
}

export interface Connector {
  platform: SourcePlatform
  name: string
  connected: boolean
  account?: string
  lastSync?: string
  episodes?: number
}

export interface Entity {
  id: string
  name: string
  kind: 'Protein' | 'Assay' | 'Hypothesis' | 'Protocol' | 'Experiment' | 'Person' | 'Dataset'
  mentions: number
  lastTouched: string
}

export interface Person {
  id: string
  name: string
  role: string
  accent: string
}
