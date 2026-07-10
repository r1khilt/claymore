/**
 * RunResultCard — the resolution banner shown once a gap's run returns. The run
 * trace + metrics render above (AgentTurn / AnalysisCard); this card is the
 * moment the edge resolves: dashed-gold → green (confirmed), or cracks red
 * (refuted), or stays gated (wet-lab, awaiting approval).
 */
import { motion } from 'framer-motion'
import { CheckCircle2, XCircle, ShieldAlert } from 'lucide-react'
import type { Gap } from '@/lib/projectTypes'
import type { GapRunResult } from '@/lib/projectStore'

export function RunResultCard({ gap, result }: { gap: Gap; result: GapRunResult }) {
  const confirmed = result.verdict === 'confirmed'
  const gated = result.verdict === 'gated'

  const tone = gated
    ? { icon: ShieldAlert, cls: 'bg-amber-400/16 text-amber-500 ring-amber-400/30', head: 'Simulated · awaiting approval' }
    : confirmed
      ? { icon: CheckCircle2, cls: 'bg-sage-500/14 text-sage-700 ring-sage-500/25', head: 'Link supported — edge resolved' }
      : { icon: XCircle, cls: 'bg-clay-500/14 text-clay-500 ring-clay-500/25', head: 'Refuted — edge cracked red' }
  const Icon = tone.icon

  const confirmedClosing: Record<string, string> = {
    open_triad: 'This link is now supported. Two downstream hypotheses just became testable.',
    contradiction: 'The conflict is resolved — the supported side is confirmed, the other refuted.',
    fragile: 'Corroborated by an independent line — the edge is upgraded from fragile to supported.',
    link_prediction: 'The predicted edge is now supported and written back to memory.',
  }
  const closing = gated
    ? 'A physical run needs your one-tap approval — nothing runs until you confirm.'
    : confirmed
      ? (confirmedClosing[gap.kind] ?? 'The predicted edge is now supported and written back to memory.')
      : 'The predicted edge did not hold — recorded so it is not re-proposed.'

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className={`rounded-2xl p-4 ring-1 ring-inset ${tone.cls}`}
    >
      <div className="flex items-center gap-2">
        <Icon className="size-5 shrink-0" strokeWidth={2.25} />
        <span className="text-[14px] font-semibold">{tone.head}</span>
      </div>
      <div className="mt-1.5 text-[13.5px] font-medium text-ink/85">{result.title}</div>
      <p className="mt-1 text-[13px] leading-relaxed text-ink/70">{closing}</p>
    </motion.div>
  )
}
