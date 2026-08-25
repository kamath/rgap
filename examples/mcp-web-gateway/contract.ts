import assert from 'node:assert/strict';
import { z } from 'zod';

const AuthenticationSchema = z.enum([
  'public',
  'oauth-state',
  'better-auth-session',
]);

const PublicRouteSchema = z.object({
  methods: z.array(z.enum(['GET', 'POST', 'DELETE'])).min(1),
  path: z.string().startsWith('/'),
  authentication: AuthenticationSchema,
});

export const publicRoutes = z.array(PublicRouteSchema).parse([
  {
    methods: ['GET', 'POST'],
    path: '/api/auth/*',
    authentication: 'public',
  },
  {
    methods: ['GET', 'POST'],
    path: '/api/connections',
    authentication: 'better-auth-session',
  },
  {
    methods: ['GET', 'DELETE'],
    path: '/api/connections/:connectionId',
    authentication: 'better-auth-session',
  },
  {
    methods: ['POST'],
    path: '/api/connections/:connectionId/authorize',
    authentication: 'better-auth-session',
  },
  {
    methods: ['POST'],
    path: '/mcp/:connectionId',
    authentication: 'better-auth-session',
  },
  {
    methods: ['GET'],
    path: '/oauth/callback',
    authentication: 'oauth-state',
  },
  {
    methods: ['GET'],
    path: '/oauth/client-metadata.json',
    authentication: 'public',
  },
]);

export const CreateConnectionInputSchema = z.object({
  displayName: z.string().trim().min(1).max(80),
  serverUrl: z.url({ protocol: /^https?$/ }),
}).strict();

export const ConnectionStatusSchema = z.enum([
  'authorization_required',
  'connected',
  'error',
]);

export const ConnectionSchema = z.object({
  id: z.string().startsWith('cn_'),
  displayName: z.string(),
  serverUrl: z.url({ protocol: /^https?$/ }),
  status: ConnectionStatusSchema,
  authorizationUrl: z.url().optional(),
}).strict();

export type CreateConnectionInput = z.infer<
  typeof CreateConnectionInputSchema
>;
export type Connection = z.infer<typeof ConnectionSchema>;

const forbiddenPublicPaths = [
  /^\/rgap(?:\/|$)/,
  /^\/api\/resources(?:\/|$)/,
  /^\/api\/grants(?:\/|$)/,
  /^\/api\/tokens(?:\/|$)/,
  /^\/api\/audit(?:\/|$)/,
  /\/tools(?:\/|$)/,
];

for (const route of publicRoutes) {
  assert.equal(
    forbiddenPublicPaths.some((pattern) => pattern.test(route.path)),
    false,
    `Public route is outside the gateway contract: ${route.path}`,
  );
}

assert.deepEqual(
  publicRoutes
    .filter((route) => route.path.startsWith('/mcp'))
    .map((route) => route.path),
  ['/mcp/:connectionId'],
);

const input = CreateConnectionInputSchema.parse({
  displayName: 'GitHub',
  serverUrl: 'https://mcp.example.com',
});

const response = ConnectionSchema.parse({
  id: 'cn_01k4example',
  displayName: input.displayName,
  serverUrl: input.serverUrl,
  status: 'authorization_required',
  authorizationUrl:
    'https://authorization.example.com/authorize?client_id=gateway',
});

assert.equal('resourceId' in response, false);
assert.equal('rgapBearer' in response, false);
assert.equal('oauthTokens' in response, false);

console.log(JSON.stringify({ publicRoutes, example: response }, null, 2));
