import { cn } from '@/lib/utils'

function initials(name: string): string {
  const parts = name.trim().split(/\s+/)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export function Avatar({
  name,
  accent = '#6f7268',
  size = 30,
  className,
}: {
  name: string
  accent?: string
  size?: number
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-grid shrink-0 place-items-center rounded-full font-medium',
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.4,
        background: `color-mix(in oklab, ${accent} 18%, white)`,
        color: `color-mix(in oklab, ${accent} 78%, black)`,
        boxShadow: 'inset 0 0 0 1px rgba(28,29,24,0.06)',
      }}
      aria-hidden
    >
      {initials(name)}
    </span>
  )
}
