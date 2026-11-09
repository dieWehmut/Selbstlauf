import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { createStaticDemoApi } from './api/static-demo';
import { LocaleBridge } from './i18n';
import './styles/index.css';
import './styles/navigation-rail.css';
import './styles/fonts.css';
import './sidebar/sidebar-projects.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LocaleBridge />
    <App api={import.meta.env.VITE_STATIC_DEMO === 'true' ? createStaticDemoApi() : undefined} />
  </StrictMode>,
);
