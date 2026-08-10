import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 8787,
    proxy: {
      '/api': 'http://localhost:7878',
      '/ws':  { target: 'ws://localhost:7878', ws: true },
    },
  },
});
