import type { ReactNode } from 'react'

/** Minimal markdown for agent answers: **bold**, `-`/`*` bullets, paragraphs.
 *  Plain text (the mock) passes through unchanged. */

function inline(text: string, key: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith('**') && part.endsWith('**') ? (
      <strong key={`${key}-${i}`} className="font-semibold text-ink">
        {part.slice(2, -2)}
      </strong>
    ) : (
      <span key={`${key}-${i}`}>{part}</span>
    ),
  )
}

export function Markdown({ text }: { text: string }) {
  const lines = text.split('\n')
  const out: ReactNode[] = []
  let bullets: string[] = []

  const flush = () => {
    if (!bullets.length) return
    const items = bullets
    bullets = []
    out.push(
      <ul key={`ul-${out.length}`} className="my-1.5 flex list-disc flex-col gap-1 pl-5">
        {items.map((it, i) => (
          <li key={i}>{inline(it, `li-${out.length}-${i}`)}</li>
        ))}
      </ul>,
    )
  }

  lines.forEach((line, i) => {
    const bullet = line.match(/^\s*[-*]\s+(.*)/)
    if (bullet) {
      bullets.push(bullet[1])
      return
    }
    flush()
    if (line.trim()) out.push(<p key={`p-${i}`} className="my-1">{inline(line, `p-${i}`)}</p>)
  })
  flush()

  return <div className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">{out}</div>
}
