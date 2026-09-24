import adapter from '@sveltejs/adapter-static'

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    // A browser-only app: every route renders from index.html and talks to the
    // dashboard server's /api endpoints, which hold the credentials.
    adapter: adapter({ fallback: 'index.html' }),
    prerender: { entries: [] },
  },
}

export default config
