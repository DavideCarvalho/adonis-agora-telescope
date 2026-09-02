import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { TelescopeQueryProvider } from './query-provider.js';
import './index.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('#root not found');
}

createRoot(container).render(
  <StrictMode>
    <TelescopeQueryProvider>
      <App />
    </TelescopeQueryProvider>
  </StrictMode>,
);
