import { defineConfig, type Connect, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// SCALO_API_URL: point the dev proxy at an API on another port (e.g. a second checkout)
const API = process.env.SCALO_API_URL ?? 'http://localhost:4000';

/**
 * The OAuth consent screen (/oauth/consent, an SPA route) must never be framed (clickjacking). The API sets these
 * headers on the pages it serves; for the SPA it is the web server's job: here for `vite` / `vite preview`, and in
 * production on the reverse proxy / static host (see README).
 */
function noFrameConsent(): Plugin {
  const mw: Connect.NextHandleFunction = (req, res, next) => {
    if (req.url?.startsWith('/oauth/consent')) {
      res.setHeader('X-Frame-Options', 'DENY');
      res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
      res.setHeader('Referrer-Policy', 'no-referrer');
    }
    next();
  };
  return {
    name: 'scalo-no-frame-consent',
    configureServer: (server) => void server.middlewares.use(mw),
    configurePreviewServer: (server) => void server.middlewares.use(mw),
  };
}

// Only the protocol endpoints of the authorization server go to the API; /oauth/consent stays an SPA route.
// (+ the MCP server endpoint, POST /mcp, authenticated with the same access tokens)
const oauthProxy = { '^/oauth/(authorize|token|revoke|introspect)(\\?.*)?$': API, '/.well-known/': API, '^/mcp(\\?.*)?$': API };

export default defineConfig({
  plugins: [noFrameConsent(), react(), tailwindcss()],
  build: { chunkSizeWarningLimit: 1200 },
  server: {
    port: 5173,
    proxy: {
      '/api': API,
      // trailing slashes so SPA routes that merely start with the letter are not proxied
      '/p/': API,
      '/t/': API,
      '/u/': API,
      '/c/': API, // double opt-in confirmation links
      '/m/': API, // members area (courses): server-rendered pages
      '/a/': API, // affiliate area: server-rendered pages
      '/uploads/': API,
      ...oauthProxy,
    },
  },
  preview: { proxy: { '/api': API, ...oauthProxy } },
});
