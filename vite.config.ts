import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { viteSingleFile } from 'vite-plugin-singlefile'

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  server: {
    watch: {
      usePolling: true,
      interval: 100,
    },
  },
  build: {
    assetsInlineLimit: Number.POSITIVE_INFINITY,
  },
})
