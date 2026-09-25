import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { init, useApp } from './store';
import './styles.css';
import './features.css';

function Root() {
  const ready = useApp((d) => d.ready);
  if (!ready) return <div className="splash">StreamHelper</div>;
  return <App />;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

void init();
