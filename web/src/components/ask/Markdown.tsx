import type { ReactNode } from 'react'

/** Minimal markdown for agent answers: **bold**, `code`, [links](url), `#` headings, `-`/`*`
 *  bullets, GFM pipe tables, and paragraphs. Plain text passes through unchanged. */

function inline(text: string, key: string): ReactNode[] {
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)]+\))/g)
  return tokens.map((part, i) => {
    const k = `${key}-${i}`
    if (part.startsWith('**') && part.endsWith('**'))
      return (
        <strong key={k} className="font-semibold text-ink">
          {part.slice(2, -2)}
        </strong>
      )
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1)
      return (
        <code key={k} className="rounded bg-black/[0.06] px-1 py-0.5 font-mono text-[0.85em]">
          {part.slice(1, -1)}
        </code>
      )
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/)
    if (link)
      return (
        <a
          key={k}
          href={link[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sage-700 underline underline-offset-2 hover:text-sage-800"
        >
          {link[1]}
        </a>
      )
    return <span key={k}>{part}</span>
  })
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((c) => c.trim())
}

// A GFM table separator row, e.g. `| --- | :--: |`.
const isSep = (line: string) => line.includes('-') && /^\s*\|?[\s:|-]+\|?\s*$/.test(line)

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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // GFM table: a `|`-row followed by a separator row, then data rows.
    if (
      line.includes('|') &&
      line.replace(/[|\s]/g, '') &&
      i + 1 < lines.length &&
      isSep(lines[i + 1])
    ) {
      flush()
      const header = splitRow(line)
      const rows: string[][] = []
      let j = i + 2
      while (j < lines.length && lines[j].includes('|') && lines[j].trim()) {
        rows.push(splitRow(lines[j]))
        j++
      }
      out.push(
        <div key={`t-${i}`} className="my-2 overflow-x-auto">
          <table className="w-full border-collapse text-[12.5px]">
            <thead>
              <tr>
                {header.map((h, c) => (
                  <th
                    key={c}
                    className="border-b border-line px-2 py-1 text-left font-semibold text-ink"
                  >
                    {inline(h, `th-${i}-${c}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((cell, ci) => (
                    <td key={ci} className="border-b border-line/60 px-2 py-1 align-top text-ink/85">
                      {inline(cell, `td-${i}-${ri}-${ci}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      )
      i = j - 1
      continue
    }

    const heading = line.match(/^(#{1,4})\s+(.*)/)
    if (heading) {
      flush()
      const big = heading[1].length <= 2
      out.push(
        <div
          key={`h-${i}`}
          className={
            big
              ? 'mt-2.5 text-[14px] font-semibold text-ink'
              : 'mt-2 text-[13px] font-semibold text-ink/90'
          }
        >
          {inline(heading[2], `h-${i}`)}
        </div>,
      )
      continue
    }

    const bullet = line.match(/^\s*[-*]\s+(.*)/)
    if (bullet) {
      bullets.push(bullet[1])
      continue
    }
    flush()
    if (line.trim())
      out.push(
        <p key={`p-${i}`} className="my-1">
          {inline(line, `p-${i}`)}
        </p>,
      )
  }
  flush()

  return <div className="[&>*:first-child]:mt-0 [&>*:last-child]:mb-0">{out}</div>
}
