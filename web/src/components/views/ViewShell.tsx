import type { ReactNode } from 'react'

export function ViewShell({
  title,
  subtitle,
  action,
  children,
}: {
  title: string
  subtitle?: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[920px] px-8 py-9">
        <header className="mb-7 flex items-end justify-between gap-4">
          <div>
            <h1 className="font-serif text-[36px] leading-none tracking-tight text-ink">{title}</h1>
            {subtitle && <p className="mt-2.5 text-[14.5px] text-muted">{subtitle}</p>}
          </div>
          {action}
        </header>
        {children}
      </div>
    </div>
  )
}
