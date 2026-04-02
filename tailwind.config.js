/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        abyss: '#0B0F0A',
        moss: '#141A11',
        olive: '#1A1F14',
        neon: '#B7FF00',
        mint: '#7CFFB2',
        cloud: '#EAEAEA',
      },
      boxShadow: {
        glow: '0 0 0 1px rgba(183,255,0,0.18), 0 0 28px rgba(183,255,0,0.12), inset 0 1px 0 rgba(255,255,255,0.08)',
        float: '0 24px 80px rgba(0,0,0,0.45), inset 0 1px 0 rgba(255,255,255,0.08)',
      },
      borderRadius: {
        skin: '28px',
        orb: '999px',
      },
    },
  },
  plugins: [],
}
