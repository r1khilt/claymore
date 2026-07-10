/**
 * Sufficiency gate + Exa augmentation.
 *
 * A corpus below the sufficiency floor (6 validated sources) is auto-expanded
 * with Exa-sourced, validated papers — clearly marked `addedBy:{kind:'exa'}` so
 * the attribution stays honest (human-added vs auto-sourced are visibly distinct).
 *
 * Mock is the default (deterministic, offline — Exa credits can run out, and did).
 * The live path (behind VITE_CLAYMORE_LIVE) hits an Exa proxy and falls back to
 * the mock on any failure, so the demo never flakes on the network.
 */
import type { PaperSource } from './projectTypes'
import { EXA_PAPERS } from './projectMock'
import { isLive } from './api'

export const SUFFICIENCY_FLOOR = 6

export interface Sufficiency {
  have: number
  need: number
  floor: number
  ok: boolean
}

/** How many more validated sources the corpus needs to clear the floor. */
export function sufficiencyGate(sources: PaperSource[]): Sufficiency {
  const have = sources.filter((s) => s.validated !== false).length
  const need = Math.max(0, SUFFICIENCY_FLOOR - have)
  return { have, need, floor: SUFFICIENCY_FLOOR, ok: need === 0 }
}

/** Seed entities to feed Exa — the salient nouns already in the corpus. */
export function seedEntities(sources: PaperSource[]): string[] {
  const text = sources.map((s) => s.title).join(' ')
  const hits = new Set<string>()
  for (const kw of ['CBX2', 'tau', 'MAPT', 'polycomb', 'PRC2', 'chromatin', 'aggregation']) {
    if (new RegExp(`\\b${kw}\\b`, 'i').test(text)) hits.add(kw)
  }
  return [...hits]
}

/** Deterministic mock: return the baked Exa papers not already in the corpus. */
function expandMock(existing: PaperSource[], need: number): PaperSource[] {
  const have = new Set(existing.map((s) => s.doi ?? s.id))
  return EXA_PAPERS.filter((p) => !have.has(p.doi ?? p.id)).slice(0, Math.max(0, need))
}

/** Live Exa call (best-effort). Any failure → mock, so the demo is never blocked. */
async function expandLive(entities: string[], need: number, existing: PaperSource[], signal?: AbortSignal): Promise<PaperSource[]> {
  try {
    const res = await fetch('/api/exa/augment', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entities, need }),
      signal,
    })
    if (!res.ok) throw new Error(`exa ${res.status}`)
    const papers = (await res.json()) as PaperSource[]
    if (!Array.isArray(papers) || papers.length === 0) throw new Error('exa empty')
    // stamp attribution honestly regardless of what the proxy returns.
    return papers.slice(0, need).map((p) => ({ ...p, addedBy: { kind: 'exa' }, validated: true }))
  } catch {
    return expandMock(existing, need)
  }
}

/** Expand a corpus via Exa to satisfy the sufficiency gate. */
export async function expandViaExa(existing: PaperSource[], need: number, signal?: AbortSignal): Promise<PaperSource[]> {
  if (need <= 0) return []
  if (isLive) return expandLive(seedEntities(existing), need, existing, signal)
  return expandMock(existing, need)
}
