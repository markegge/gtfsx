import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App'
import { BUILD_STAMP } from './utils/buildStamp'

// Publish the build stamp on window so the deployed bundle is self-describing
// (and so the stamp survives tree-shaking). In prod devtools, `__GTFSX_BUILD__`
// answers "was this built with the live Stripe key, backend and billing on?"
// without guessing from behaviour. See src/utils/buildStamp.ts.
declare global {
  interface Window {
    __GTFSX_BUILD__?: typeof BUILD_STAMP;
  }
}
window.__GTFSX_BUILD__ = BUILD_STAMP;

// Remove any server-rendered SEO snapshot before the SPA mounts. The worker
// injects a [data-prerendered] block for hard-loads of /community/* (forum)
// and /pricing, /demo (marketing) so search engines and no-JS readers see
// indexable content; once the SPA bundle runs, the live UI replaces it.
// See worker/forum/dispatcher.ts and worker/marketing/ssr.ts.
document.querySelectorAll('[data-prerendered]').forEach((el) => el.remove());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
