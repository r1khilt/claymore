/**
 * Compact, recognizable inline-SVG brand marks. GitHub / Notion / iMessage /
 * Granola / Code render in `currentColor` (the chip sets the color); Slack and
 * Gmail carry their own iconic multicolor.
 */
import type { SVGProps } from 'react'

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
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M7 5.6h3.1l5.3 7.4V5.6H18v12.8h-2.9l-5.5-7.7v7.7H7z" />
    </svg>
  )
}

export function IMessageLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" {...props}>
      <path d="M12 3.4c-4.97 0-9 3.2-9 7.15 0 2.28 1.35 4.3 3.45 5.6-.2 1.02-.77 2.1-1.6 2.9-.2.2-.07.55.22.53 1.7-.13 3.2-.72 4.3-1.55.83.2 1.72.32 2.63.32 4.97 0 9-3.2 9-7.15S16.97 3.4 12 3.4Z" />
    </svg>
  )
}

export function GranolaLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" {...props}>
      <path d="M5 12v0M9 8v8M13 5v14M17 9v6M21 11v2" />
    </svg>
  )
}

export function DriveLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" {...props}>
      <path d="m8.4 3 7.2 12.5h-7.2L1.2 15.5z" fill="#00AC47" />
      <path d="M15.6 15.5 12 21.6H4.8l3.6-6.1z" fill="#0066DA" transform="translate(1 0)" />
      <path d="M22.8 15.5H8.4L12 21.6h7.2z" fill="#FFBA00" opacity="0.9" />
      <path d="M15.6 3H8.4l7.2 12.5 3.6-6.2z" fill="#EA4335" opacity="0.85" />
    </svg>
  )
}

export function CodeLogo(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="m9 8-4 4 4 4M15 8l4 4-4 4" />
    </svg>
  )
}
