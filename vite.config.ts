import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'charts',
              test: /node_modules[\\/]recharts[\\/]/,
              priority: 10,
            },
            {
              name: 'wallet',
              test: /node_modules[\\/]ethers[\\/]/,
              priority: 10,
            },
          ],
        },
      },
    },
  },
})
