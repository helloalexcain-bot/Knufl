import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import KnuflApp from '../app/page';
import '../app/globals.css';

const root = document.getElementById('root');

if (!root) throw new Error('Knufl could not find its app root.');

createRoot(root).render(
  <StrictMode>
    <KnuflApp />
  </StrictMode>,
);
