import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  root: '.', // make sure root is project root
  build: {
    outDir: 'dist', // where Render will deploy from
  },
  server: {
    port: 5173,
  },
})
