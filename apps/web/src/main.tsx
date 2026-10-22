import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { createStaticDemoApi } from './api/static-demo';
import { LocaleBridge } from './i18n';
import './styles/index.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LocaleBridge />
    <App api={import.meta.env.VITE_STATIC_DEMO === 'true' ? createStaticDemoApi() : undefined} />
  </StrictMode>,
);
