/**
 * Local store client — the browser side of "keep it all local".
 *
 * Talks to the backend `/api/local/*` routes (a single JSON file in the user's
 * own folder, `~/.claymore/local.json`, git-ignored — see src/claymore/local_store.py).
 * If the backend isn't running (the default mock demo has no server), every call
 * falls back to a `localStorage` mirror so Recent chats, Settings, profile and the
 * error log still persist across refreshes. Real token/tool metrics are only
 * produced by a live agent run, so in mock mode the metrics simply read as zero.
 */
import type { AgentEvent } from './agent'

export type ReasoningLevel = 'low' | 'medium' | 'high'

export interface Profile {
  name: string
  lab: string
  email: string
  avatarColor: string
  avatarDataUrl: string | null
}

export interface LocalSettings {
  anthropicApiKey: string
  voyageApiKey: string
  reasoningLevel: ReasoningLevel
  debug: boolean
  liveMode: boolean
}

export interface Metrics {
  totalRuns: number
  totalErrors: number
  inputTokens: number
  outputTokens: number
  toolCalls: number
  toolCounts: Record<string, number>
  models: Record<string, number>
  byDay: Record<string, { runs: number; inputTokens: number; outputTokens: number; toolCalls: number }>
  lastRunAt: string | null
}

export interface ErrorEntry {
  id: string
  ts: string
  level: string
  message: string
  context: string
}

export interface ChatSummary {
  id: string
  title: string
  createdAt: string | null
  updatedAt: string | null
  turnCount: number
}

export interface ChatTurn {
  q: string
  events: AgentEvent[]
}

export interface Chat {
  id: string
  title: string
  createdAt: string | null
  updatedAt: string | null
  turns: ChatTurn[]
}

export interface LocalState {
  profile: Profile
  settings: LocalSettings
  metrics: Metrics
  errorLog: ErrorEntry[]
  chats: ChatSummary[]
  meta: { path: string }
}

const BASE = '/api/local'
const MIRROR_KEY = 'claymore.local'

function defaultState(): Omit<LocalState, 'chats'> & { chats: Chat[] } {
  return {
    profile: { name: 'Rikhil T', lab: 'Claymore Lab', email: '', avatarColor: '#3f7d5c', avatarDataUrl: null },
    settings: { anthropicApiKey: '', voyageApiKey: '', reasoningLevel: 'medium', debug: false, liveMode: false },
    metrics: {
      totalRuns: 0, totalErrors: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0,
      toolCounts: {}, models: {}, byDay: {}, lastRunAt: null,
    },
    errorLog: [],
    chats: [],
    meta: { path: 'localStorage (backend offline)' },
  }
}

/* ------------------------------------------------------------------ mirror -- */

type Mirror = ReturnType<typeof defaultState>

function readMirror(): Mirror {
  try {
    const raw = localStorage.getItem(MIRROR_KEY)
    if (!raw) return defaultState()
    return { ...defaultState(), ...(JSON.parse(raw) as Partial<Mirror>) }
  } catch {
    return defaultState()
  }
}

function writeMirror(m: Mirror): void {
  try {
    localStorage.setItem(MIRROR_KEY, JSON.stringify(m))
  } catch {
    /* quota / private mode — best effort */
  }
}

function patchMirror(fn: (m: Mirror) => void): Mirror {
  const m = readMirror()
  fn(m)
  writeMirror(m)
  return m
}

function summary(c: Chat): ChatSummary {
  return { id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, turnCount: c.turns.length }
}

/* ---------------------------------------------------------------- fetch io -- */

async function tryJson<T>(input: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(input, init)
    if (!res.ok) return null
    return (await res.json()) as T
  } catch {
    return null
  }
}

function jsonBody(method: string, body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
}

/* ------------------------------------------------------------------- state -- */

export async function loadState(): Promise<LocalState> {
  const remote = await tryJson<LocalState>(`${BASE}/state`)
  if (remote) {
    // Keep the mirror's full chat bodies but adopt the backend's authoritative doc.
    patchMirror((m) => {
      m.profile = remote.profile
      m.settings = remote.settings
      m.metrics = remote.metrics
      m.errorLog = remote.errorLog
    })
    return remote
  }
  const m = readMirror()
  return { ...m, chats: m.chats.map(summary).sort(byUpdated) }
}

function byUpdated(a: ChatSummary, b: ChatSummary): number {
  return (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')
}

/* ------------------------------------------------------------------- chats -- */

export async function getChat(id: string): Promise<Chat | null> {
  const remote = await tryJson<Chat>(`${BASE}/chats/${encodeURIComponent(id)}`)
  if (remote) return remote
  return readMirror().chats.find((c) => c.id === id) ?? null
}

export async function saveChat(chat: Chat): Promise<void> {
  const now = new Date().toISOString()
  const record: Chat = {
    ...chat,
    title: chat.title || chat.turns.find((t) => t.q.trim())?.q.slice(0, 80) || 'New chat',
    createdAt: chat.createdAt ?? now,
    updatedAt: now,
  }
  patchMirror((m) => {
    const i = m.chats.findIndex((c) => c.id === record.id)
    if (i >= 0) m.chats[i] = record
    else m.chats.unshift(record)
    m.chats.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    m.chats = m.chats.slice(0, 200)
  })
  await fetch(`${BASE}/chats/${encodeURIComponent(record.id)}`, jsonBody('PUT', record)).catch(() => {})
}

export async function deleteChat(id: string): Promise<void> {
  patchMirror((m) => {
    m.chats = m.chats.filter((c) => c.id !== id)
  })
  await fetch(`${BASE}/chats/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {})
}

export async function clearChats(): Promise<void> {
  patchMirror((m) => {
    m.chats = []
  })
  await fetch(`${BASE}/chats`, { method: 'DELETE' }).catch(() => {})
}

/* ------------------------------------------------------- settings & profile -- */

export async function patchSettings(patch: Partial<LocalSettings>): Promise<LocalSettings> {
  const m = patchMirror((mm) => {
    mm.settings = { ...mm.settings, ...patch }
  })
  const remote = await tryJson<LocalSettings>(`${BASE}/settings`, jsonBody('PATCH', patch))
  return remote ?? m.settings
}

export async function patchProfile(patch: Partial<Profile>): Promise<Profile> {
  const m = patchMirror((mm) => {
    mm.profile = { ...mm.profile, ...patch }
  })
  const remote = await tryJson<Profile>(`${BASE}/profile`, jsonBody('PATCH', patch))
  return remote ?? m.profile
}

/* ---------------------------------------------------------- errors & reset -- */

export async function logClientError(message: string, context = 'web'): Promise<void> {
  patchMirror((m) => {
    m.errorLog.push({ id: Math.random().toString(16).slice(2, 8), ts: new Date().toISOString(), level: 'error', message, context })
    m.errorLog = m.errorLog.slice(-200)
    m.metrics.totalErrors += 1
  })
  await fetch(`${BASE}/errors`, jsonBody('POST', { message, context })).catch(() => {})
}

export async function clearErrors(): Promise<void> {
  patchMirror((m) => {
    m.errorLog = []
  })
  await fetch(`${BASE}/errors`, { method: 'DELETE' }).catch(() => {})
}

export async function resetMetrics(): Promise<void> {
  patchMirror((m) => {
    m.metrics = defaultState().metrics
  })
  await fetch(`${BASE}/metrics`, { method: 'DELETE' }).catch(() => {})
}

/** Wipe the whole local mirror + backend chats/errors/metrics (Settings → Data → Clear). */
export async function clearAll(): Promise<void> {
  writeMirror(defaultState())
  await Promise.all([
    fetch(`${BASE}/chats`, { method: 'DELETE' }).catch(() => {}),
    fetch(`${BASE}/errors`, { method: 'DELETE' }).catch(() => {}),
    fetch(`${BASE}/metrics`, { method: 'DELETE' }).catch(() => {}),
  ])
}

export function newChatId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `chat-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`
  }
}
