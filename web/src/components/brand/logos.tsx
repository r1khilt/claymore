/**
 * Compact, recognizable inline-SVG brand marks. GitHub / Notion / iMessage /
 * Granola / Code render in `currentColor` (the chip sets the color); Slack and
 * Gmail carry their own iconic multicolor.
 */
import { useId, type SVGProps } from 'react'

export function SlackLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <rect x="3.6" y="8.9" width="16.8" height="2.7" rx="1.35" fill="#36C5F0" />
      <rect x="3.6" y="12.4" width="16.8" height="2.7" rx="1.35" fill="#ECB22E" />
      <rect x="8.9" y="3.6" width="2.7" height="16.8" rx="1.35" fill="#2EB67D" />
      <rect x="12.4" y="3.6" width="2.7" height="16.8" rx="1.35" fill="#E01E5A" />
    </svg>
  )
}

export function GmailLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path d="M4 18.5h2.6V11l5.4 4 5.4-4v7.5H20a1.5 1.5 0 0 0 1.5-1.5V7.2a1.7 1.7 0 0 0-2.72-1.36L12 10.9 5.22 5.84A1.7 1.7 0 0 0 2.5 7.2V17A1.5 1.5 0 0 0 4 18.5Z" fill="#EA4335" />
      <path d="M4 18.5h2.6V11L2.5 7.9V17A1.5 1.5 0 0 0 4 18.5Z" fill="#C5221F" />
      <path d="M20 18.5h-2.6V11l4.1-3.1V17a1.5 1.5 0 0 1-1.5 1.5Z" fill="#FBBC04" />
    </svg>
  )
}

export function GithubLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  )
}

export function NotionLogo(props: SVGProps<SVGSVGElement>) {
  // Official Notion mark (tilted N in a page), monochrome — renders in currentColor.
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952l1.448.328s0 .84-1.168.84l-3.22.187c-.093-.187 0-.653.327-.746l.84-.234V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.14c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z" />
    </svg>
  )
}

export function IMessageLogo(props: SVGProps<SVGSVGElement>) {
  // Apple Messages app icon: green gradient tile + white speech bubble (full-bleed).
  // Unique gradient id per instance — a shared literal id resolves to whichever
  // copy is first in the DOM, so the fill breaks when that copy unmounts.
  const gradId = useId()
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <defs>
        <linearGradient id={gradId} x1="12" y1="0" x2="12" y2="24" gradientUnits="userSpaceOnUse">
          <stop stopColor="#5BF675" />
          <stop offset="1" stopColor="#12C230" />
        </linearGradient>
      </defs>
      <rect width="24" height="24" rx="5.4" fill={`url(#${gradId})`} />
      <path d="M12 5.15c-4.34 0-7.85 2.83-7.85 6.33 0 1.99 1.14 3.77 2.9 4.94-.05.9-.53 2-1.28 2.72-.2.19-.07.53.21.52 1.5-.05 2.85-.62 3.82-1.44.68.13 1.4.2 2.2.2 4.34 0 7.85-2.83 7.85-6.33S16.34 5.15 12 5.15Z" fill="#fff" />
    </svg>
  )
}

export function GranolaLogo(props: SVGProps<SVGSVGElement>) {
  // Granola app icon: dark inked spiral on a lime tile (full-bleed).
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <rect width="24" height="24" rx="5.4" fill="#A7C23E" />
      <path
        d="M18.7 6.4a8 8 0 1 0 1.05 6.35 6.3 6.3 0 1 0-10.5 2.6 4.7 4.7 0 1 0 6.35-6.4 3.2 3.2 0 1 0 1.4 4.35"
        fill="none"
        stroke="#191b18"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function DriveLogo(props: SVGProps<SVGSVGElement>) {
  // Official Google Drive tri-color triangle, own fills — render on a light chip.
  return (
    <svg viewBox="0 0 87.3 78" fill="none" {...props}>
      <path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da" />
      <path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0-1.2 4.5h27.5z" fill="#00ac47" />
      <path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335" />
      <path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d" />
      <path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc" />
      <path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00" />
    </svg>
  )
}

export function CodeLogo(props: SVGProps<SVGSVGElement>) {
  // Claude Code pixel-invader mark, terracotta on a light chip (multicolor).
  return (
    <svg viewBox="0 0 22 20" fill="#c9724e" {...props}>
      {/* arms band (extends past the body on both sides) */}
      <rect x="1" y="8" width="20" height="3" />
      {/* body */}
      <rect x="4" y="3" width="14" height="12" />
      {/* legs */}
      <rect x="5" y="15" width="1.7" height="3" />
      <rect x="8" y="15" width="1.7" height="3" />
      <rect x="12.3" y="15" width="1.7" height="3" />
      <rect x="15.3" y="15" width="1.7" height="3" />
      {/* eyes */}
      <rect x="7" y="5.8" width="1.9" height="3.5" fill="#fff" />
      <rect x="13.1" y="5.8" width="1.9" height="3.5" fill="#fff" />
    </svg>
  )
}
