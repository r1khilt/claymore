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
