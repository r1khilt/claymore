/**
 * ProjectList — the entry cards. A project = a research question + a paper
 * corpus; open one to build its live graph and mine gaps.
 */
import { motion } from 'framer-motion'
import { Plus, Waypoints, FileText, ArrowRight } from 'lucide-react'
import type { Project } from '@/lib/projectTypes'
import { Avatar } from '@/components/ui/Avatar'
import { DEMO_GAP_COUNT } from '@/lib/projectMock'

function ProjectCard({ project, onOpen }: { project: Project; onOpen: () => void }) {
  const humans = project.sources.filter((s) => s.addedBy.kind === 'human')
  return (
    <motion.button
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      onClick={onOpen}
      className="glass group flex w-full max-w-[560px] flex-col rounded-2xl p-5 text-left transition-all hover:-translate-y-0.5 hover:shadow-[0_18px_50px_-18px_rgba(28,29,24,0.28)]"
    >
      <div className="flex items-center gap-2.5">
        <span className="grid size-9 place-items-center rounded-xl bg-sage-500/12 text-sage-600">
          <Waypoints className="size-5" strokeWidth={1.9} />
        </span>
        <h3 className="font-serif text-[21px] leading-none tracking-tight text-ink">{project.title}</h3>
        <ArrowRight className="ml-auto size-4 text-faint opacity-0 transition-opacity group-hover:opacity-100" strokeWidth={2} />
      </div>
      <p className="mt-3 line-clamp-2 text-[13.5px] leading-relaxed text-ink/70">{project.question}</p>

      <div className="mt-4 flex items-center gap-3 text-[12px] text-muted">
        <span className="flex items-center gap-1.5">
          <FileText className="size-3.5 text-faint" strokeWidth={2} />
          {project.sources.length} papers
        </span>
        <span className="text-faint">·</span>
        <span className="rounded-full bg-sage-500/12 px-2 py-0.5 font-medium text-sage-700">
          {DEMO_GAP_COUNT} gaps ready
        </span>
        <div className="ml-auto flex -space-x-1.5">
          {humans.slice(0, 3).map((s) =>
            s.addedBy.kind === 'human' ? (
              <Avatar key={s.id} name={s.addedBy.person.name} accent={s.addedBy.person.accent} size={22} photo={s.addedBy.person.avatar} className="ring-2 ring-white/70" />
            ) : null,
          )}
        </div>
      </div>
    </motion.button>
  )
}

export function ProjectList({ projects, onOpen, onNew }: { projects: Project[]; onOpen: (p: Project) => void; onNew: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-8 pt-8">
        <div>
          <h1 className="font-serif text-[30px] leading-none tracking-tight text-ink">Projects</h1>
          <p className="mt-2 text-[13.5px] text-muted">
            A research question, a paper corpus, and a live gap engine — what should the lab test next?
          </p>
        </div>
        <button
          onClick={onNew}
          className="flex items-center gap-1.5 rounded-full bg-sage-500 px-4 py-2 text-[13.5px] font-medium text-white shadow-sm transition-colors hover:bg-sage-600"
        >
          <Plus className="size-4" strokeWidth={2.5} />
          New project
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-8 py-7">
        <div className="flex flex-col gap-4">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} onOpen={() => onOpen(p)} />
          ))}
        </div>
      </div>
    </div>
  )
}
