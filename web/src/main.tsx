import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { AuthProvider } from './auth/AuthProvider.tsx';
import { I18nProvider } from './i18n/I18nProvider.tsx';
import { ThemeProvider } from './theme/ThemeProvider.tsx';
import './styles/tokens.css';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root 元素不存在');

createRoot(rootEl).render(
  <StrictMode>
    <ThemeProvider>
      <I18nProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </I18nProvider>
    </ThemeProvider>
  </StrictMode>,
);
