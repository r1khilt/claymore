import { useEffect, useRef, useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
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
  Microscope,
  ChevronDown,
  Compass,
  Keyboard,
  Send,
  GitBranch,
  Database,
  ShieldCheck,
  Camera,
  MousePointerClick,
  Move,
  Timer,
  ScanEye,
  Image as ImageIcon,
  type LucideIcon,
} from 'lucide-react'
import type { AgentEvent, AnalysisResult, ScienceSession, ScienceStep, ToolName } from '@/lib/agent'
import type { Protocol } from '@/lib/protocol'
import { cn } from '@/lib/utils'
import { AnswerView } from './AnswerView'
import { ProtocolCard } from './ProtocolCard'
import { MLResultCard } from './MLResultCard'

const TOOL_ICON: Record<ToolName, LucideIcon> = {
  search_memory: Search,
  ingest: Download,
  generate_protocol: FlaskConical,
  simulate: Play,
  run_analysis: Cpu,
  run_claude_science: Microscope,
  run_ml_analysis: Cpu,
}

// Icon per Claude Science step action (computer-use actions + the simulated stages).
const ACTION_ICON: Record<string, LucideIcon> = {
  navigate: Compass,
  type: Keyboard,
  key: Keyboard,
  hold_key: Keyboard,
  submit: Send,
  plan: GitBranch,
  connect: Database,
  compute: Cpu,
  review: ShieldCheck,
  render: ImageIcon,
  screenshot: Camera,
  left_click: MousePointerClick,
  right_click: MousePointerClick,
  middle_click: MousePointerClick,
  double_click: MousePointerClick,
  triple_click: MousePointerClick,
  left_click_drag: MousePointerClick,
  mouse_move: MousePointerClick,
  scroll: Move,
  wait: Timer,
  zoom: ScanEye,
  cursor_position: ScanEye,
}

type ToolEnd = Extract<AgentEvent, { type: 'toolEnd' }>

function findEnd(events: AgentEvent[], id: string): ToolEnd | undefined {
  return events.find((e): e is ToolEnd => e.type === 'toolEnd' && e.id === id)
}

function findScienceSession(events: AgentEvent[], id: string): ScienceSession | undefined {
  const e = events.find((e) => e.type === 'scienceSession' && e.id === id)
  return e?.type === 'scienceSession' ? e.session : undefined
}

function collectScienceSteps(events: AgentEvent[], id: string): ScienceStep[] {
  return events.flatMap((e) => (e.type === 'scienceStep' && e.id === id ? [e.step] : []))
}

/* ---------------------------------------------------------------- activity -- */

type TraceItem =
  | { kind: 'thought'; text: string }
  | { kind: 'tool'; tool: ToolName; label: string; end?: ToolEnd }

function ActivityRow({ item, live }: { item: TraceItem; live: boolean }) {
  if (item.kind === 'thought') {
    return (
      <div className="flex items-start gap-2 py-1 text-[12.5px] italic leading-relaxed text-muted">
        <Sparkles className="mt-[3px] size-3 shrink-0 text-sage-400" strokeWidth={2} />
        <span>{item.text}</span>
      </div>
    )
  }
  const Icon = TOOL_ICON[item.tool] ?? Sparkles
  return (
    <div className="flex items-start gap-2 py-1 text-[12.5px] leading-relaxed">
      <Icon className="mt-[3px] size-3 shrink-0 text-muted" strokeWidth={2} />
      <span className="min-w-0 flex-1">
        <span className="text-ink/80">{item.label}</span>
        {item.end?.summary && <span className="text-faint"> — {item.end.summary}</span>}
      </span>
      {live ? (
        <Loader2 className="mt-[3px] size-3 shrink-0 animate-spin text-sage-500" strokeWidth={2.5} />
      ) : item.end?.ok === false ? (
        <X className="mt-[3px] size-3 shrink-0 text-clay-500" strokeWidth={2.5} />
      ) : item.end ? (
        <Check className="mt-[3px] size-3 shrink-0 text-sage-600" strokeWidth={2.5} />
      ) : null}
    </div>
  )
}

/** The agent's thinking + tool trail, folded into a single quiet line. While the turn
 *  runs it stays open so you can watch; once the answer lands it collapses to
 *  "Worked · n steps" and expands on click. */
function Activity({ items, live }: { items: TraceItem[]; live: boolean }) {
  const [open, setOpen] = useState(false)
  const expanded = live || open
  const steps = items.filter((i) => i.kind === 'tool').length
  if (items.length === 0) return null

  return (
    <div className="flex flex-col">
      <button
        onClick={() => !live && setOpen((v) => !v)}
        className={cn(
          'flex w-fit items-center gap-1.5 rounded-md py-0.5 text-[12px] font-medium transition-colors',
          live ? 'cursor-default text-sage-700' : 'text-faint hover:text-muted',
        )}
      >
        {live ? (
          <Loader2 className="size-3 animate-spin text-sage-500" strokeWidth={2.5} />
        ) : (
          <Sparkles className="size-3 text-sage-400" strokeWidth={2} />
        )}
        {live ? 'Working…' : `Worked · ${steps || items.length} step${(steps || items.length) === 1 ? '' : 's'}`}
        {!live && (
          <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} strokeWidth={2} />
        )}
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="trace"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="ml-[5px] mt-1.5 flex flex-col border-l border-sage-500/20 pl-3.5">
              {items.map((item, i) => (
                <ActivityRow key={i} item={item} live={live && item.kind === 'tool' && !item.end} />
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

/* ------------------------------------------------------------------- cards -- */

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

function ScienceStatusBadge({
  status,
  running,
}: {
  status?: ScienceSession['status']
  running: boolean
}) {
  if (running && !status) {
    return (
      <span className="ml-auto flex items-center gap-1.5 rounded-full bg-sage-500/12 px-2 py-0.5 text-[11px] font-medium text-sage-700">
        <Loader2 className="size-3 animate-spin" strokeWidth={2.5} />
        Running
      </span>
    )
  }
  if (status === 'completed') {
    return (
      <span className="ml-auto rounded-full bg-sage-500/14 px-2 py-0.5 text-[11px] font-medium text-sage-700">
        Live · localhost:8765
      </span>
    )
  }
  return (
    <span className="ml-auto rounded-full bg-amber-400/18 px-2 py-0.5 text-[11px] font-medium text-amber-500">
      Preview
    </span>
  )
}

function ScienceStepRow({ step, current }: { step: ScienceStep; current: boolean }) {
  const Icon = ACTION_ICON[step.action] ?? Sparkles
  return (
    <div
      data-current={current}
      className={cn(
        'flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-[12.5px] transition-colors',
        current ? 'bg-sage-500/12 text-sage-700' : 'text-muted',
      )}
    >
      <span
        className={cn(
          'grid size-6 shrink-0 place-items-center rounded-md',
          current ? 'bg-sage-500 text-white' : 'bg-black/[0.05] text-faint',
        )}
      >
        <Icon className="size-3.5" strokeWidth={2} />
      </span>
      <span className={cn('min-w-0 flex-1 truncate', current && 'font-medium')}>{step.detail}</span>
      {step.screenshot && (
        <img
          src={step.screenshot}
          alt=""
          className="h-8 w-12 shrink-0 rounded-md object-cover ring-1 ring-inset ring-black/[0.06]"
        />
      )}
      <span className="shrink-0 tabular-nums text-[11px] text-faint">{step.index}</span>
    </div>
  )
}

/** The Claude Science panel: a live "screenshot" of Claymore operating the app, the result once it
 *  finishes, and a collapsible dropdown to replay every step it took. Driven by the streamed
 *  `scienceStep` events while running, then the final `scienceSession`. */
function ScienceSessionCard({
  session,
  liveSteps,
  running,
}: {
  session?: ScienceSession
  liveSteps: ScienceStep[]
  running: boolean
}) {
  const [open, setOpen] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const steps = session?.steps.length ? session.steps : liveSteps
  const latest = steps[steps.length - 1]
  const done = !!session

  useEffect(() => {
    if (open) listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' })
  }, [steps.length, open])

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass-raised overflow-hidden rounded-2xl"
    >
      <div className="flex items-center gap-2.5 px-4 pt-3.5">
        <span className="grid size-7 place-items-center rounded-lg bg-sage-500/14 text-sage-700">
          <Microscope className="size-4" strokeWidth={2} />
        </span>
        <div className="text-[14px] font-medium text-ink">Claude Science</div>
        <ScienceStatusBadge status={session?.status} running={running} />
      </div>

      {latest?.screenshot && (
        <div className="mx-4 mt-3 overflow-hidden rounded-xl ring-1 ring-inset ring-black/[0.06]">
          <div className="relative">
            <img src={latest.screenshot} alt="Claude Science" className="block w-full" />
            {running && !done && (
              <span className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-black/55 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur">
                <span className="size-1.5 animate-pulse rounded-full bg-sage-300" />
                Live
              </span>
            )}
          </div>
          {latest.detail && (
            <div className="flex items-center gap-1.5 border-t border-line/70 bg-white/50 px-3 py-1.5 text-[12px] text-muted">
              {running && !done && (
                <Loader2 className="size-3 shrink-0 animate-spin text-sage-500" strokeWidth={2.5} />
              )}
              <span className="truncate">{latest.detail}</span>
            </div>
          )}
        </div>
      )}

      {session && (
        <div className="px-4 pt-3">
          <p className="text-[13.5px] leading-relaxed text-ink/80">{session.resultSummary}</p>
          {session.metrics.length > 0 && (
            <div className="mt-3 grid grid-cols-3 gap-2">
              {session.metrics.map((m) => (
                <div
                  key={m.label}
                  className="rounded-xl bg-white/50 p-2.5 ring-1 ring-inset ring-black/[0.05]"
                >
                  <div className="font-serif text-[19px] leading-none text-ink">{m.value}</div>
                  <div className="mt-1 text-[11px] text-faint">{m.label}</div>
                </div>
              ))}
            </div>
          )}
          {session.note && (
            <div className="mt-2.5 text-[11.5px] leading-relaxed text-amber-500/90">
              {session.note}
            </div>
          )}
        </div>
      )}

      <div className="mt-3">
        <button
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center gap-2 border-t border-line/70 px-4 py-2.5 text-[12.5px] font-medium text-muted transition-colors hover:bg-black/[0.02] hover:text-ink"
        >
          <Play className="size-3.5 text-sage-600" strokeWidth={2.5} />
          Watch Claymore work
          <span className="text-faint">
            · {steps.length} step{steps.length === 1 ? '' : 's'}
          </span>
          <ChevronDown
            className={cn('ml-auto size-4 transition-transform', open && 'rotate-180')}
            strokeWidth={2}
          />
        </button>
        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              key="steps"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden border-t border-line/70"
            >
              <div ref={listRef} className="no-scrollbar max-h-64 space-y-0.5 overflow-y-auto p-2">
                {steps.map((s, idx) => (
                  <ScienceStepRow
                    key={s.index}
                    step={s}
                    current={running && !done && idx === steps.length - 1}
                  />
                ))}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </motion.div>
  )
}

/* -------------------------------------------------------------------- turn -- */

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
    (e) =>
      e.type === 'answer' ||
      e.type === 'protocol' ||
      e.type === 'analysis' ||
      e.type === 'scienceSession' ||
      e.type === 'mlResult',
  )
  // The live agent surfaces its final prose as both a `thought` and the `answer`;
  // don't render the thought twice.
  const answerTexts = new Set(
    events.flatMap((e) => (e.type === 'answer' ? [e.text.trim()] : [])),
  )

  // Split the stream: thoughts + ordinary tool calls fold into the Activity line;
  // answers and rich cards render full-size below it.
  const trace: TraceItem[] = []
  const blocks: ReactNode[] = []
  events.forEach((e, i) => {
    switch (e.type) {
      case 'thought':
        if (!answerTexts.has(e.text.trim())) trace.push({ kind: 'thought', text: e.text })
        break
      case 'toolStart': {
        const end = findEnd(events, e.id)
        if (e.tool === 'run_claude_science') {
          blocks.push(
            <ScienceSessionCard
              key={i}
              session={findScienceSession(events, e.id)}
              liveSteps={collectScienceSteps(events, e.id)}
              running={!end && running}
            />,
          )
        } else {
          trace.push({ kind: 'tool', tool: e.tool, label: e.label, end })
        }
        break
      }
      case 'answer':
        blocks.push(<AnswerView key={i} reply={{ text: e.text, citations: e.citations }} />)
        break
      case 'protocol':
        blocks.push(<ProtocolCard key={i} protocol={e.protocol} onOpen={() => onOpenProtocol(e.protocol)} />)
        break
      case 'analysis':
        blocks.push(<AnalysisCard key={i} result={e.analysis} />)
        break
      case 'mlResult':
        blocks.push(<MLResultCard key={i} result={e.result} />)
        break
      case 'error':
        blocks.push(
          <div key={i} className="glass rounded-xl px-3.5 py-2.5 text-[13px] text-clay-500">
            {e.message}
          </div>,
        )
        break
      default:
        // scienceStep / scienceSession render inside the ScienceSessionCard; 'done' is a no-op.
        break
    }
  })

  return (
    <div className="flex flex-col gap-3">
      <Activity items={trace} live={running && !hasResult} />
      {blocks}
      {running && !hasResult && trace.length === 0 && (
        <div className="flex items-center gap-1.5 pl-0.5 text-[13px] text-faint">
          <span className="size-1.5 animate-pulse rounded-full bg-sage-400" />
          working
        </div>
      )}
    </div>
  )
}
