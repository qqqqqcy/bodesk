import {fileURLToPath} from 'node:url';
import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: fileURLToPath(new URL('./mock', import.meta.url)),
  publicDir: false,
  plugins: [react()],
  build: {outDir: 'dist', emptyOutDir: true, target: 'chrome120'},
});
