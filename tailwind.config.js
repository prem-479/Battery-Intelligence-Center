/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      boxShadow: {
        panel: '0 16px 28px rgba(0, 0, 0, 0.25)',
      },
    },
  },
  plugins: [],
}
