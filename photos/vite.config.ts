import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/photos/',
  build: {
    outDir: '../static/photos',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/index': 'https://photos.recap.pinewood.one',
    }
  }
})
