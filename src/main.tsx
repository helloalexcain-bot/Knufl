import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// GitHub Pages intentionally keeps the export-capable local prototype while
// the Vinext/Cloudflare entry point serves the authenticated voice preview.
import KnuflApp from '../app/legacy-prototype';
import '../app/globals.css';

const root = document.getElementById('root');

if (!root) throw new Error('Knufl could not find its app root.');

createRoot(root).render(
  <StrictMode>
    <KnuflApp />
  </StrictMode>,
);
