import { Component, type ReactNode } from 'react'

/**
 * A local error boundary so a single render throw degrades in place instead of white-screening the
 * whole app. The heavy surfaces are lazy three.js Canvases (Deck3D, KnowledgeGraph3D) — a WebGL
 * context-loss or a malformed scene should fall back to `fallback`, not take down the sidebar and
 * chat with it. (React error boundaries only catch render/lifecycle throws, not async rejections.)
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode; onError?: (e: unknown) => void },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: unknown) {
    this.props.onError?.(error)
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children
  }
}
