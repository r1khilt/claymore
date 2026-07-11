import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    port: 5173,
    // Proxy to the FastAPI backend (the real Ask loop) so the dev UI can hit it
    // without CORS. See src/lib/api.ts — VITE_CLAYMORE_LIVE flips mock -> real.
    // CLAYMORE_API_TARGET overrides the backend (e.g. point at a worktree backend
    // on another port); defaults to the usual :8000.
    proxy: {
      '/api': {
        target: process.env.CLAYMORE_API_TARGET || 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})
