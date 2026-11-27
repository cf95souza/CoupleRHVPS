import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { AppRoutes } from './routes'

import { Toaster } from 'sonner';
import { ConfirmDialogProvider } from './components/ConfirmDialogProvider';
import { PromptDialogProvider } from './components/PromptDialogProvider';
import { UpdateNotifier } from './components/UpdateNotifier';
import { syncOfflinePunches } from './lib/offlinePunchQueue';
import { pontoEnterpriseService } from './services/timeTracking/pontoEnterpriseService';

if (typeof window !== 'undefined') {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
  window.addEventListener('online', () => {
    syncOfflinePunches((punches) => pontoEnterpriseService.syncOfflinePunches(punches)).catch(() => {});
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ConfirmDialogProvider>
      <PromptDialogProvider>
        <AppRoutes />
        <Toaster position="top-right" richColors closeButton />
        <UpdateNotifier />
      </PromptDialogProvider>
    </ConfirmDialogProvider>
  </StrictMode>,
)
