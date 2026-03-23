/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/renderer/**/*.{js,ts,jsx,tsx,html}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        surface: {
          0: '#0a0a0a',
          1: '#141414',
          2: '#1e1e1e',
          3: '#282828',
          4: '#333333',
        },
        accent: {
          DEFAULT: '#d4a574',
          dim: '#a67c52',
          bright: '#e8c49a',
        },
      },
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'SF Pro Text', 'SF Pro Display', 'Helvetica Neue', 'sans-serif'],
      },
    },
  },
  plugins: [],
}
