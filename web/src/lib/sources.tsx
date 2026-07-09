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
}

export const PLATFORM: Record<SourcePlatform, PlatformMeta> = {
  slack: { label: 'Slack', color: '#4a154b', Logo: SlackLogo, multicolor: true },
  gmail: { label: 'Gmail', color: '#ea4335', Logo: GmailLogo, multicolor: true },
  github: { label: 'GitHub', color: '#1f2328', Logo: GithubLogo },
  notion: { label: 'Notion', color: '#2f2c28', Logo: NotionLogo },
  imessage: { label: 'iMessage', color: '#0a84ff', Logo: IMessageLogo },
  granola: { label: 'Granola', color: '#0f766e', Logo: GranolaLogo },
  gdrive: { label: 'Drive', color: '#1a73e8', Logo: DriveLogo, multicolor: true },
  gdocs: { label: 'Docs', color: '#1a73e8', Logo: DriveLogo, multicolor: true },
  codelogs: { label: 'Claude Code', color: '#b4623f', Logo: CodeLogo },
  manual: { label: 'Note', color: '#6f7268', Logo: CodeLogo },
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
  const glyph = Math.round(size * 0.62)
  return (
    <span
      className={cn('inline-grid shrink-0 place-items-center rounded-[7px]', className)}
      style={{
        width: size,
        height: size,
        background: m.multicolor ? 'rgba(255,255,255,0.92)' : m.color,
        color: m.multicolor ? undefined : '#fff',
        boxShadow: m.multicolor ? 'inset 0 0 0 1px rgba(28,29,24,0.07)' : undefined,
      }}
      aria-hidden
    >
      <Logo width={glyph} height={glyph} />
    </span>
  )
}
