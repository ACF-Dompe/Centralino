/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: {
          DEFAULT: '#003366',
          50: '#e6eef5',
          100: '#c2d4e6',
          500: '#003366',
          600: '#002a55',
          700: '#001f40',
          900: '#000f1f',
        },
        brand: {
          red: '#E30613',
          gold: '#D4AF37',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
      },
      boxShadow: {
        card: '0 1px 3px rgba(0,0,0,0.05), 0 1px 2px rgba(0,0,0,0.04)',
        elev: '0 10px 30px -10px rgba(0, 51, 102, 0.18)',
      },
    },
  },
  plugins: [],
};
