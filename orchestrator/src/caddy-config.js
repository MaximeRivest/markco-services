/**
 * Generate Caddy JSON config for the markco.dev platform.
 */

const DOMAIN = process.env.DOMAIN || 'markco.dev';
const IS_LOCAL_DOMAIN = /^(\d|localhost)/.test(DOMAIN);
const HOSTS = IS_LOCAL_DOMAIN ? [DOMAIN] : [DOMAIN, `www.${DOMAIN}`];

function matchPath(path) {
  return [{ host: HOSTS, path: [path] }];
}

/**
 * Generate the full Caddy JSON config.
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
                match: matchPath('/@*'),
                handle: [{
                  handler: 'reverse_proxy',
                  upstreams: [{ dial: 'localhost:3003' }],
                }],
              },
              // Auth callback → orchestrator (OAuth callbacks + magic link verify)
              {
                '@id': 'auth-callback',
                match: [{ host: HOSTS, path: ['/auth/callback/*', '/auth/email/verify'] }],
                handle: [{
                  handler: 'reverse_proxy',
                  upstreams: [{ dial: 'localhost:3000' }],
                }],
              },
              // Auth API routes → auth-service
              {
                '@id': 'auth',
                match: matchPath('/auth/*'),
                handle: [{
                  handler: 'reverse_proxy',
                  upstreams: [{ dial: 'localhost:3001' }],
                }],
              },
              // Join/invite routes
              {
                '@id': 'join',
                match: matchPath('/join/*'),
                handle: [{
                  handler: 'reverse_proxy',
                  upstreams: [{ dial: 'localhost:3001' }],
                }],
              },
              // Umami analytics: tracking script
              {
                '@id': 'umami-script',
                match: matchPath('/script.js'),
                handle: [{
                  handler: 'reverse_proxy',
                  upstreams: [{ dial: 'localhost:3005' }],
                }],
              },
              // Umami analytics: event collector (must be before /api/*)
              {
                '@id': 'umami-send',
                match: matchPath('/api/send'),
                handle: [{
                  handler: 'reverse_proxy',
                  upstreams: [{ dial: 'localhost:3005' }],
                }],
              },
              // Umami analytics: dashboard
              {
                '@id': 'umami-dashboard',
                match: matchPath('/analytics/*'),
                handle: [{
                  handler: 'reverse_proxy',
                  upstreams: [{ dial: 'localhost:3005' }],
                }],
              },
              // API routes
              {
                '@id': 'api',
                match: matchPath('/api/*'),
                handle: [{
                  handler: 'reverse_proxy',
                  upstreams: [{ dial: 'localhost:3000' }],
                }],
              },
              // Orchestrator user-facing routes
              {
                '@id': 'orchestrator-pages',
                match: [{
                  host: HOSTS,
                  path: ['/login', '/login/*', '/dashboard', '/sandbox', '/hooks/*', '/projects/*', '/u/*', '/logout', '/api/logout', '/.well-known/assetlinks.json'],
                }],
                handle: [{
                  handler: 'reverse_proxy',
                  upstreams: [{ dial: 'localhost:3000' }],
                }],
              },
              // Static assets (editor JS, reader JS)
              {
                '@id': 'static',
                match: [{ host: HOSTS, path: ['/static/*'] }],
                handle: [
                  {
                    handler: 'file_server',
                    root: '/opt/markco/static',
                  },
                ],
              },
              // Default fallback → orchestrator
              {
                '@id': 'fallback',
                match: [{ host: HOSTS }],
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
