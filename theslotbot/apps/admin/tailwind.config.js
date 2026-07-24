/**
 * tailwind.config.js
 *
 * DESIGN INTENT:
 * This is an operational tool a reception desk glances at between
 * clients, often on a phone screen, often in a hurry. It is not a
 * marketing surface — there's no "brand moment" to spend boldness on.
 * The design decision here is the opposite of a landing page: maximum
 * legibility, unambiguous status color-coding, and a type scale that
 * stays readable at a glance from arm's length on a counter-mounted
 * tablet. Restraint itself is the choice.
 *
 * Status colors are semantic and consistent everywhere a BookingStatus
 * appears — confirmed is always the same blue, completed always the
 * same green, cancelled always the same neutral-red — so staff build
 * pattern recognition across the whole app rather than re-reading text
 * every time.
 */

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Neutral base — a slightly warm gray, not stark black/white,
        // easier on the eyes for a screen that's on all day at a desk.
        ink: {
          50: '#f7f7f6',
          100: '#eeeeec',
          200: '#d9d9d5',
          300: '#b8b8b1',
          400: '#8f8f86',
          500: '#6b6b62',
          600: '#52524a',
          700: '#403f39',
          800: '#2d2c28',
          900: '#1c1b18',
        },
        // Status semantics — used consistently for BookingStatus badges,
        // never repurposed for anything else in the UI.
        status: {
          confirmed: '#2563eb',   // blue — booked, on the books
          completed: '#15803d',   // green — done, success
          cancelled: '#78716c',   // muted stone — neutral, not alarming
          noshow: '#b91c1c',      // red — the one status that needs attention
          pending: '#a16207',     // amber — awaiting action
        },
        accent: {
          DEFAULT: '#7c3aed', // violet — used sparingly: primary actions only
          hover: '#6d28d9',
        },
      },
      fontFamily: {
        // A workhorse humanist sans for UI text — optimized for dense
        // data tables and small counter-mounted screens, not display use.
        sans: ['Inter', 'system-ui', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
