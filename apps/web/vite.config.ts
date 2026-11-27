import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'fs';

function pwaAndVersionPlugin() {
  return {
    name: 'couplerh-pwa-and-version',
    buildStart() {
      const version = { version: Date.now().toString() };
      if (!fs.existsSync('public')) {
        fs.mkdirSync('public', { recursive: true });
      }
      fs.writeFileSync('public/version.json', JSON.stringify(version, null, 2));

      if (fs.existsSync('public/manifest.json')) {
        fs.copyFileSync('public/manifest.json', 'public/manifest.webmanifest');
      }

      const swContent = `/* coupleRH Enterprise Service Worker (PONTO-03 Offline Resiliente) */
const CACHE_NAME = 'couplerh-pwa-${version.version}';
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/manifest.json', '/pwa-192x192.png', '/pwa-512x512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
    event.respondWith(fetch(event.request));
    return;
  }
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((resp) => {
        if (resp && resp.status === 200 && url.origin === self.location.origin) {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
        }
        return resp;
      }).catch(() => caches.match('/index.html'));
    })
  );
});
`;
      fs.writeFileSync('public/sw.js', swContent);
    },
  };
}

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    pwaAndVersionPlugin(),
  ],
  server: {
    port: 3000,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/health': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});
