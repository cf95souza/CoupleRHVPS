import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import fs from 'fs';

function versionPlugin() {
  return {
    name: 'generate-version-json',
    buildStart() {
      const version = { version: Date.now().toString() };
      if (!fs.existsSync('public')) {
        fs.mkdirSync('public', { recursive: true });
      }
      fs.writeFileSync('public/version.json', JSON.stringify(version, null, 2));
    },
  };
}

export default defineConfig({
  plugins: [
    tailwindcss(),
    react(),
    versionPlugin(),
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
