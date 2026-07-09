import { MeshGradient } from '@paper-design/shaders-react'

/**
 * The airy backdrop, composited in layers (fixed, behind everything):
 *   1. an animated paper-shaders mesh gradient (soft pastels, very slow)
 *   2. a faint, blurred nature horizon fading up into the canvas
 *   3. a cream wash + top glow for legibility and lift
 * Swap the photo by changing HORIZON.
 */
const HORIZON = '/backgrounds/dawn-hill.jpg'
const MESH_COLORS = ['#eef4ea', '#e6eef1', '#f4ece0', '#ebe7f1', '#f5f3ee']

export function Background() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <MeshGradient
        colors={MESH_COLORS}
        distortion={0.85}
        swirl={0.06}
        grainOverlay={0.05}
        speed={0.14}
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.72 }}
      />

      {/* faint nature horizon, fading up into the canvas */}
      <div
        className="absolute inset-x-0 bottom-0 h-[64%] bg-cover bg-center"
        style={{
          backgroundImage: `url(${HORIZON})`,
          opacity: 0.24,
          filter: 'saturate(1.04) blur(1px)',
          WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, black 58%, black 100%)',
          maskImage: 'linear-gradient(to bottom, transparent 0%, black 58%, black 100%)',
        }}
      />

      {/* cream wash top→bottom keeps content legible and the top airy */}
      <div
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(to bottom, rgba(244,242,236,0.42) 0%, rgba(244,242,236,0.04) 28%, rgba(244,242,236,0.30) 74%, rgba(244,242,236,0.62) 100%)',
        }}
      />

      {/* soft overhead glow */}
      <div
        className="absolute left-1/2 top-[-28%] h-[72vh] w-[82vw] -translate-x-1/2 rounded-full"
        style={{ background: 'radial-gradient(closest-side, rgba(255,255,255,0.55), transparent)' }}
      />
    </div>
  )
}
