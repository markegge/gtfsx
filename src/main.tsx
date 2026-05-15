import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'

// Remove the server-rendered SEO snapshot (if any) before the SPA mounts. The
// worker injects this block at #forum-ssr for /community/* hard-loads so search
// engines and no-JS readers see indexable content; once the SPA bundle runs,
// the live UI replaces it. See worker/forum/dispatcher.ts.
document.getElementById('forum-ssr')?.remove();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
