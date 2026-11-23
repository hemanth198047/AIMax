import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// Belt and braces: if anything ever scrolls the page or the app frame, put it straight back.
const pinTop = (t: EventTarget | null) => { const el = t as HTMLElement | null; if (el === document.documentElement || el === document.body || el === document.getElementById('root') || el?.dataset?.testid === 'app-root') { if (el!.scrollTop || el!.scrollLeft) { el!.scrollTop = 0; el!.scrollLeft = 0; } } };
document.addEventListener('scroll', (e) => pinTop(e.target), true);
window.addEventListener('scroll', () => { if (window.scrollY || window.scrollX) window.scrollTo(0, 0); });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
