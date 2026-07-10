import { motion } from 'framer-motion'
import {
  Loader2,
  Check,
  X,
  Sparkles,
  Search,
  Download,
  FlaskConical,
  Play,
  Cpu,
  type LucideIcon,
} from 'lucide-react'
import type { AgentEvent, AnalysisResult, ToolName } from '@/lib/agent'
import type { Protocol } from '@/lib/protocol'
import { AnswerView } from './AnswerView'
import { ProtocolCard } from './ProtocolCard'
import { MLResultCard } from './MLResultCard'

const TOOL_ICON: Record<ToolName, LucideIcon> = {
  search_memory: Search,
  ingest: Download,
  generate_protocol: FlaskConical,
  simulate: Play,
  run_analysis: Cpu,
  run_ml_analysis: Cpu,
}

type ToolEnd = Extract<AgentEvent, { type: 'toolEnd' }>

function findEnd(events: AgentEvent[], id: string): ToolEnd | undefined {
  return events.find((e): e is ToolEnd => e.type === 'toolEnd' && e.id === id)
}

function Thought({ text }: { text: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-center gap-2 text-[13.5px] text-muted"
    >
      <Sparkles className="size-3.5 shrink-0 text-sage-500" strokeWidth={2} />
      <span className="italic">{text}</span>
    </motion.div>
  )
}

function ToolStep({
  tool,
  label,
  end,
  running,
}: {
  tool: ToolName
  label: string
  end?: ToolEnd
  running: boolean
}) {
  const Icon = TOOL_ICON[tool] ?? Sparkles
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-start gap-2.5 rounded-xl border border-black/[0.05] bg-white/45 px-3 py-2"
    >
      <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-md bg-black/[0.05] text-muted">
        <Icon className="size-3.5" strokeWidth={2} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] text-ink">{label}</span>
          {running ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin text-sage-500" strokeWidth={2.25} />
          ) : end?.ok ? (
            <Check className="size-3.5 shrink-0 text-sage-600" strokeWidth={2.5} />
          ) : (
            <X className="size-3.5 shrink-0 text-clay-500" strokeWidth={2.5} />
          )}
        </div>
        {end && <div className="mt-0.5 text-[12px] text-faint">{end.summary}</div>}
      </div>
    </motion.div>
  )
}

function AnalysisCard({ result }: { result: AnalysisResult }) {
  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="glass-raised rounded-2xl p-4">
      <div className="flex items-center gap-2.5">
        <span className="grid size-7 place-items-center rounded-lg bg-ink text-white">
          <Cpu className="size-4" strokeWidth={2} />
        </span>
        <div className="text-[14px] font-medium text-ink">{result.title}</div>
        <span className="ml-auto rounded-full bg-ink/[0.06] px-2 py-0.5 text-[11px] font-medium text-muted">
          Modal · GPU
        </span>
      </div>
      <p className="mt-2.5 text-[13.5px] leading-relaxed text-ink/80">{result.summary}</p>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {result.metrics.map((mtr) => (
          <div key={mtr.label} className="rounded-xl bg-white/50 p-2.5 ring-1 ring-inset ring-black/[0.05]">
            <div className="font-serif text-[19px] leading-none text-ink">{mtr.value}</div>
            <div className="mt-1 text-[11px] text-faint">{mtr.label}</div>
          </div>
        ))}
      </div>
    </motion.div>
  )
}

export function AgentTurn({
  events,
  running,
  onOpenProtocol,
}: {
  events: AgentEvent[]
  running: boolean
  onOpenProtocol: (p: Protocol) => void
}) {
  const hasResult = events.some(
    (e) => e.type === 'answer' || e.type === 'protocol' || e.type === 'analysis' || e.type === 'mlResult',
  )
  // The live agent surfaces its final prose as both a `thought` and the `answer`;
  // don't render the thought twice.
  const answerTexts = new Set(
    events.flatMap((e) => (e.type === 'answer' ? [e.text.trim()] : [])),
  )
  return (
    <div className="flex flex-col gap-2.5">
      {events.map((e, i) => {
        switch (e.type) {
          case 'thought':
            if (answerTexts.has(e.text.trim())) return null
            return <Thought key={i} text={e.text} />
          case 'toolStart': {
            const end = findEnd(events, e.id)
            return <ToolStep key={i} tool={e.tool} label={e.label} end={end} running={!end && running} />
          }
          case 'answer':
            return (
              <div key={i} className="mt-1">
                <AnswerView reply={{ text: e.text, citations: e.citations }} />
              </div>
            )
          case 'protocol':
            return (
              <div key={i} className="mt-1">
                <ProtocolCard protocol={e.protocol} onOpen={() => onOpenProtocol(e.protocol)} />
              </div>
            )
          case 'analysis':
            return (
              <div key={i} className="mt-1">
                <AnalysisCard result={e.analysis} />
              </div>
            )
          case 'mlResult':
            return (
              <div key={i} className="mt-1">
                <MLResultCard result={e.result} />
              </div>
            )
          case 'error':
            return (
              <div key={i} className="glass rounded-xl px-3.5 py-2.5 text-[13px] text-clay-500">
                {e.message}
              </div>
            )
          default:
            return null
        }
      })}
      {running && !hasResult && (
        <div className="flex items-center gap-1.5 pl-0.5 text-[13px] text-faint">
          <span className="size-1.5 animate-pulse rounded-full bg-sage-400" />
          working
        </div>
      )}
    </div>
  )
}
