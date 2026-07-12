/**
 * SlackDraftBubble — the closing loop. Claymore drafts a grounded, conversational
 * Slack message summarizing the run and hands it to you for one-tap Send (the
 * same PendingAction / Composio write-back path the rest of the app uses). Reads
 * like a real Slack composer, pre-filled — "you just approve".
 */
import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Send, Check, X, Loader2 } from 'lucide-react'
import type { PendingAction } from '@/lib/types'
import { PlatformIcon } from '@/lib/sources'
import { sendSlack } from '@/lib/api'

export function SlackDraftBubble({ action }: { action: PendingAction }) {
  const [state, setState] = useState<'draft' | 'sending' | 'sent' | 'dismissed'>('draft')
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(action.preview)
  // true = really posted to Slack via Composio; false = optimistic (backend offline / mock demo).
  const [live, setLive] = useState(false)
  if (state === 'dismissed') return null

  async function send() {
    setEditing(false)
    setState('sending')
    const res = await sendSlack(action.target, text)
    setLive(res.ok)
    setState('sent') // always resolve to sent — real when the backend is up, optimistic otherwise
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="glass-raised overflow-hidden rounded-2xl"
    >
      <div className="flex items-center gap-2.5 px-4 pt-3.5">
        <PlatformIcon platform="slack" size={22} />
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-ink">{action.target}</div>
          <div className="text-[11.5px] text-faint">Draft reply · Claymore</div>
        </div>
        <span className="ml-auto rounded-md bg-black/[0.05] px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted">
          {action.token}
        </span>
      </div>

      <div className="px-4 pb-2 pt-2.5">
        <div className="rounded-xl bg-white/55 p-3 ring-1 ring-inset ring-black/[0.05]">
          <div className="flex items-center gap-2">
            <span className="grid size-6 place-items-center rounded-md bg-sage-500 text-[10px] font-semibold text-white">
              CL
            </span>
            <span className="text-[12.5px] font-semibold text-ink">Claymore</span>
            <span className="text-[11px] text-faint">just now</span>
            {state === 'draft' && (
              <button
                onClick={() => setEditing((v) => !v)}
                className="ml-auto text-[11.5px] font-medium text-sage-600 transition-colors hover:text-sage-700"
              >
                {editing ? 'Done' : 'Edit'}
              </button>
            )}
          </div>
          {editing ? (
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoFocus
              rows={Math.min(9, Math.max(4, Math.ceil(text.length / 52)))}
              className="mt-1.5 w-full resize-y rounded-lg border border-sage-500/30 bg-white/70 p-2 text-[13.5px] leading-relaxed text-ink/90 focus:border-sage-500/60 focus:outline-none"
            />
          ) : (
            <p className="mt-1.5 whitespace-pre-wrap text-[13.5px] leading-relaxed text-ink/85">{text}</p>
          )}
        </div>
      </div>

      <div className="flex items-center gap-2 px-4 pb-3.5 pt-1">
        <AnimatePresence mode="wait" initial={false}>
          {state === 'sent' ? (
            <motion.div
              key="sent"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              className="flex items-center gap-1.5 rounded-lg bg-sage-500/14 px-3 py-1.5 text-[13px] font-medium text-sage-700"
            >
              <Check className="size-4" strokeWidth={2.5} />
              {live ? 'Posted to' : 'Sent to'} {action.target}
            </motion.div>
          ) : (
            <motion.div key="actions" className="flex items-center gap-2">
              <button
                onClick={send}
                disabled={state === 'sending'}
                className="flex items-center gap-1.5 rounded-lg bg-sage-500 px-3.5 py-1.5 text-[13px] font-medium text-white shadow-sm transition-colors hover:bg-sage-600 disabled:opacity-70"
              >
                {state === 'sending' ? (
                  <>
                    <Loader2 className="size-4 animate-spin" strokeWidth={2.25} />
                    Sending…
                  </>
                ) : (
                  <>
                    <Send className="size-4" strokeWidth={2.25} />
                    Send
                  </>
                )}
              </button>
              <button
                onClick={() => setEditing((v) => !v)}
                disabled={state === 'sending'}
                className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-muted transition-colors hover:bg-black/5 hover:text-ink disabled:opacity-50"
              >
                {editing ? 'Done' : 'Edit'}
              </button>
              <button
                onClick={() => setState('dismissed')}
                className="grid size-8 place-items-center rounded-lg text-faint transition-colors hover:bg-black/5 hover:text-ink"
                title="Dismiss"
              >
                <X className="size-4" strokeWidth={2} />
              </button>
            </motion.div>
          )}
        </AnimatePresence>
        <span className="ml-auto text-[11.5px] text-faint">One tap — posts to the lab.</span>
      </div>
    </motion.div>
  )
}
