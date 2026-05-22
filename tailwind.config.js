/** @type {import('tailwindcss').Config} */
export default {
  content: ['./src/renderer/index.html', './src/renderer/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: '#0b0d10',
          panel: '#14171c',
          subtle: '#1b1f26',
        },
        accent: {
          DEFAULT: '#7c5cff',
          glow: '#a48bff',
        },
        state: {
          idle: '#6b7280',
          listening: '#22c55e',
          thinking: '#eab308',
          speaking: '#7c5cff',
          error: '#ef4444',
        },
      },
      fontFamily: {
        sans: ['system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
        mono: ['ui-monospace', 'Menlo', 'Consolas', 'monospace'],
      },
      animation: {
        'pulse-slow': 'pulse 2.4s ease-in-out infinite',
        'orb-breathe': 'orb-breathe 3s ease-in-out infinite',
      },
      keyframes: {
        'orb-breathe': {
          '0%, 100%': { transform: 'scale(1)', opacity: '0.85' },
          '50%': { transform: 'scale(1.06)', opacity: '1' },
        },
      },
    },
  },
  plugins: [],
};
