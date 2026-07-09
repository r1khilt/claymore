import type { ComponentType, SVGProps } from 'react'
import {
  SlackLogo,
  GmailLogo,
  GithubLogo,
  NotionLogo,
  IMessageLogo,
  GranolaLogo,
  DriveLogo,
  CodeLogo,
} from '@/components/brand/logos'
import type { SourcePlatform } from './types'
import { cn } from './utils'

export interface PlatformMeta {
  label: string
  color: string
  Logo: ComponentType<SVGProps<SVGSVGElement>>
  /** logo carries its own colors -> render on a light chip. */
  multicolor?: boolean
  /** logo paints its own rounded tile (bg + mark) -> render edge-to-edge, no chip. */
  fullBleed?: boolean
  /** raster logo in /public/logos -> render as <img> instead of the inline SVG. */
  imgSrc?: string
}

export const PLATFORM: Record<SourcePlatform, PlatformMeta> = {
  slack: { label: 'Slack', color: '#4a154b', Logo: SlackLogo, multicolor: true },
  gmail: { label: 'Gmail', color: '#ea4335', Logo: GmailLogo, multicolor: true, imgSrc: '/logos/gmail.png' },
  github: { label: 'GitHub', color: '#1f2328', Logo: GithubLogo },
  notion: { label: 'Notion', color: '#2f2c28', Logo: NotionLogo },
  imessage: { label: 'iMessage', color: '#28c93f', Logo: IMessageLogo, fullBleed: true },
  granola: { label: 'Granola', color: '#a7c33e', Logo: GranolaLogo, fullBleed: true, imgSrc: '/logos/granola.png' },
  gdrive: { label: 'Drive', color: '#1a73e8', Logo: DriveLogo, multicolor: true },
  gdocs: { label: 'Docs', color: '#1a73e8', Logo: DriveLogo, multicolor: true },
  codelogs: { label: 'Claude Code', color: '#b4623f', Logo: CodeLogo, multicolor: true, imgSrc: '/logos/claude-code.png' },
  manual: { label: 'Note', color: '#6f7268', Logo: CodeLogo, multicolor: true },
}

/** A rounded app-icon chip: colored glyph on white for multicolor logos, white
 *  glyph on brand color otherwise — reads like a real app icon. */
export function PlatformIcon({
  platform,
  size = 22,
  className,
}: {
  platform: SourcePlatform
  size?: number
  className?: string
}) {
  const m = PLATFORM[platform]
  const { Logo } = m
  // full-bleed logos paint their own tile edge-to-edge; others sit on a chip.
  const glyph = m.fullBleed ? size : Math.round(size * 0.62)
  return (
    <span
      className={cn('inline-grid shrink-0 place-items-center overflow-hidden rounded-[7px]', className)}
      style={{
        width: size,
        height: size,
        background: m.fullBleed ? undefined : m.multicolor ? 'rgba(255,255,255,0.92)' : m.color,
        color: m.fullBleed || m.multicolor ? undefined : '#fff',
        boxShadow: m.fullBleed || m.multicolor ? 'inset 0 0 0 1px rgba(28,29,24,0.07)' : undefined,
      }}
      aria-hidden
    >
      {m.imgSrc ? (
        <img
          src={m.imgSrc}
          alt=""
          width={glyph}
          height={glyph}
          style={{ objectFit: m.fullBleed ? 'cover' : 'contain' }}
        />
      ) : (
        <Logo width={glyph} height={glyph} />
      )}
    </span>
  )
}
