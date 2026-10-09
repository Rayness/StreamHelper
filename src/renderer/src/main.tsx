import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyCachedAppearance } from './appearance';
import { init, useApp } from './store';
import './styles.css';
import './features.css';
import './workspace.css';
import './theme.css';

function Root() {
  const ready = useApp((d) => d.ready);
  if (!ready) return <div className="splash">StreamHelper</div>;
  return <App />;
}

applyCachedAppearance();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

// The window itself must never scroll (see `overflow: clip` in styles.css); undo any
// stray programmatic scroll so the sidebar and content can't get stuck shifted.
window.addEventListener('scroll', () => { if (window.scrollX || window.scrollY) window.scrollTo(0, 0); });

void init();
