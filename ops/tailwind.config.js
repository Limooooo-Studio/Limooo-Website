/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    '../src/templates/**/*.html',
    '../src/static/js/**/*.js',
  ],
  safelist: ['hidden', 'visible'],
  corePlugins: { preflight: true }
}
