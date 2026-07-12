/**
 * The single swap-point between mock and real. In mock mode (default) answers
 * come from the local corpus; set VITE_CLAYMORE_LIVE=1 to hit the FastAPI
 * `/api/ask` endpoint (proxied to :8000 in vite.config.ts) — the real Ask loop.
 */
import type { Reply } from './types'
import { answerFor } from './mockData'

const LIVE = import.meta.env.VITE_CLAYMORE_LIVE === '1'

export const isLive = LIVE

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new DOMException('aborted', 'AbortError'))
    })
  })
}

/** Post an approved draft to Slack via the backend Composio write-back (`/api/actions/slack`).
 *  Returns whether it was really sent — the caller falls back to an optimistic UI when the
 *  backend is offline (the mock demo), and shows a real "sent" when it's up + Slack connected. */
export async function sendSlack(channel: string, text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch('/api/actions/slack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel, text }),
    })
    if (res.ok) return { ok: true }
    const detail = await res.json().catch(() => null)
    return { ok: false, error: (detail as { detail?: string } | null)?.detail ?? `send failed (${res.status})` }
  } catch {
    return { ok: false, error: 'offline' }
  }
}

export async function ask(query: string, signal?: AbortSignal): Promise<Reply> {
  if (LIVE) {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query }),
      signal,
    })
    if (!res.ok) throw new Error(`ask failed: ${res.status}`)
    return (await res.json()) as Reply
  }
  // Mock: a touch of latency so the thinking state is visible.
  await delay(620 + Math.random() * 520, signal)
  return answerFor(query)
}
