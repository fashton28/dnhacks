import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// base: './' so the production bundle loads from file:// inside the Electron shell.
export default defineConfig({
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    target: 'es2021',
  },
});
