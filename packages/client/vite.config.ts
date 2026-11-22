import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,     // fail loudly instead of silently moving to another port
    proxy: {
      '/api': 'http://localhost:3001'
    }
  }
});
