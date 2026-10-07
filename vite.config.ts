import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('/node_modules/')) return;
          if (id.includes('/ag-psd/')) return 'psd';
          if (id.includes('/konva/') || id.includes('/react-konva/')) return 'canvas';
          if (['/react/', '/react-dom/', '/react-reconciler/', '/scheduler/'].some(name => id.includes(name))) return 'react';
        },
      },
    },
  },
});
