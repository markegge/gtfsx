import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Vite dev server proxies backend routes to `wrangler dev` on :8787 so the
// browser sees a single origin (same-origin cookies, no CORS). Start both
// with `npm run dev:all` or separately (`npm run dev` + `npm run worker:dev`).
const WORKER_ORIGIN = 'http://127.0.0.1:8787'
const proxy = Object.fromEntries(
  ['/auth', '/api', '/_import', '/_demand-tiles'].map((p) => [
    p,
    { target: WORKER_ORIGIN, changeOrigin: false, ws: false },
  ]),
)

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/',
  server: { proxy },
})
