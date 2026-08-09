import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    target: ['es2017', 'safari11', 'firefox68'],
  },
  server: {
    port: Number(process.env.PORT) || 5173,
  },
});
