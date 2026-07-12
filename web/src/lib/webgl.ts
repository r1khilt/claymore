/** True if the browser can create a WebGL context (else callers fall back to a 2D render).
 *  Releases the probe context immediately so we don't orphan a GL context per mount. */
export function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas')
    const gl = (c.getContext('webgl2') || c.getContext('webgl')) as WebGLRenderingContext | null
    if (!gl) return false
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    return false
  }
}
