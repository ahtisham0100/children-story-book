// Tailwind v4 ships its own PostCSS plugin (Lightning CSS under the hood,
// which also handles vendor prefixing) — no separate autoprefixer needed,
// unlike the v3 setup this was originally drafted against.
export default {
  plugins: {
    "@tailwindcss/postcss": {},
  },
};
