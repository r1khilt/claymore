/**
 * ProjectsView — the Projects tab. Switches between the project list and a
 * project's detail (build graph → gaps → run → resolve → Slack). Mounted by App.
 */
import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { Project } from '@/lib/projectTypes'
import { listProjects, newProject } from '@/lib/projectStore'
import { ProjectList } from './ProjectList'
import { ProjectDetail } from './ProjectDetail'

export function ProjectsView() {
  const [projects, setProjects] = useState<Project[]>(() => listProjects())
  const [open, setOpen] = useState<Project | null>(null)

  function createNew() {
    const p = newProject()
    setProjects(listProjects())
    setOpen(p)
  }

  return (
    <div className="h-full">
      <AnimatePresence mode="wait">
        {open ? (
          <motion.div
            key={`detail-${open.id}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="h-full"
          >
            {/* keyed by project id so each open project gets a fresh, isolated build */}
            <ProjectDetail key={open.id} project={open} onBack={() => setOpen(null)} />
          </motion.div>
        ) : (
          <motion.div
            key="list"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="h-full"
          >
            <ProjectList projects={projects} onOpen={setOpen} onNew={createNew} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
