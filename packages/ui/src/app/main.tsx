import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../agora-kit/fonts';
import { ThemeProvider } from '../agora-kit/theme';
import { App, TELESCOPE_ACCENT } from './App.js';
import { TelescopeQueryProvider } from './query-provider.js';
import './index.css';

const container = document.getElementById('root');
if (container === null) {
  throw new Error('#root not found');
}

createRoot(container).render(
  <StrictMode>
    <ThemeProvider storageKey="agora-telescope-theme" accent={TELESCOPE_ACCENT}>
      <TelescopeQueryProvider>
        <App />
      </TelescopeQueryProvider>
    </ThemeProvider>
  </StrictMode>,
);
