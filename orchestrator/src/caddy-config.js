/**
 * Generate Caddy JSON config for the feuille.dev platform.
 * This is the base config; dynamic user routes are added at runtime via the admin API.
 */

const DOMAIN = process.env.DOMAIN || 'feuille.dev';

/**
 * Generate the full Caddy JSON config.
 * Dynamic per-user routes (e.g. /u/{userId}/*) are added later via caddy.addRoute().
 */
export function generateCaddyConfig() {
  return {
    admin: {
      listen: 'localhost:2019',
    },
    apps: {
      http: {
        servers: {
          srv0: {
            listen: [':443', ':80'],
            routes: [
              // Published sites: /@*
              {
                '@id': 'publish',
                match: [{ path: ['/@*'] }],
                handle: [{
                  handler: 'reverse_proxy',
                  upstreams: [{ dial: 'localhost:3003' }],
                }],
              },
              // Auth callback → orchestrator (handles OAuth exchange + cookie)
              {
                '@id': 'auth-callback',
                match: [{ path: ['/auth/callback/*'] }],
                handle: [{
                  handler: 'reverse_proxy',
                  upstreams: [{ dial: 'localhost:3000' }],
                }],
              },
              // Auth API routes → auth-service
              {
                '@id': 'auth',
                match: [{ path: ['/auth/*'] }],
                handle: [{
                  handler: 'reverse_proxy',
                  upstreams: [{ dial: 'localhost:3001' }],
                }],
              },
              // Join/invite routes
              {
                '@id': 'join',
                match: [{ path: ['/join/*'] }],
                handle: [{
                  handler: 'reverse_proxy',
                  upstreams: [{ dial: 'localhost:3001' }],
                }],
              },
              // API & orchestrator routes
              {
                '@id': 'api',
                match: [{ path: ['/api/*'] }],
                handle: [{
                  handler: 'reverse_proxy',
                  upstreams: [{ dial: 'localhost:3000' }],
                }],
              },
              // Orchestrator handles login, dashboard, hooks, user editor routes, default
              {
                '@id': 'orchestrator-pages',
                match: [{ path: ['/login', '/dashboard', '/hooks/*', '/projects/*', '/u/*'] }],
                handle: [{
                  handler: 'reverse_proxy',
                  upstreams: [{ dial: 'localhost:3000' }],
                }],
              },
              // Default fallback → orchestrator
              {
                '@id': 'fallback',
                handle: [{
                  handler: 'reverse_proxy',
                  upstreams: [{ dial: 'localhost:3000' }],
                }],
              },
            ],
          },
        },
      },
    },
  };
}
