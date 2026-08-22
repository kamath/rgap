# OAuth Broker

An OAuth broker lets a person authorize a provider once and then use the resulting connection through RGAP invocations. Authorization codes, refresh tokens, and access tokens remain behind the broker.

The preferred model is mediated invocation: callers invoke RGAP resources and the trusted runtime attaches an OAuth access token to the upstream request. The broker does not vend access tokens to callers, because token vending bypasses RGAP destination policy, usage controls, auditing, and immediate invocation revocation.

## Resources

OAuth operations are ordinary executable resources backed by a provider runtime. RGAP has no provider or connection collection:

```text
oauth/
└── github/
    ├── initiate
    ├── complete
    └── revoke

connections/
└── alice/
    └── github

clients/
└── github/
    ├── client-id
    └── client-secret

tools/
└── github/
    └── create-issue
```

The deployment registers the trusted runtime once:

```ts
const rgap = createRgap({
  runtimes: {
    github: new GitHubRuntime(),
  },
});
```

`GitHubRuntime` owns GitHub's authorization and token endpoints, request formats, token extraction, refresh behavior, credential injection, and allowed API origins. Executable programs select operations and narrow their policy; they cannot replace those trusted protocol rules.

Client ID and client secret are protected values attached to ordinary resources. A user's GitHub connection is another resource with runtime-private credential state. Only the GitHub runtime can interpret that state.

## Provider operations

An administrator creates resources and publishes executable revisions:

```ts
const github = await admin.resources.create({ name: 'oauth' })
  .then((oauth) => oauth.create({ name: 'github' }));

const initiateResource = await github.create({ name: 'initiate' });
const initiate = await initiateResource.executable.create({
  runtime: 'github',
  inputSchema: {
    type: 'object',
    required: ['state', 'pkceChallenge'],
  },
  bindingSchema: {
    clientId: { kind: 'secret', access: 'use' },
  },
  program: {
    operation: 'oauth.initiate',
    scopes: ['repo', 'read:user'],
    redirectUri: 'https://gateway.company.com/oauth/callback',
  },
});

const completeResource = await github.create({ name: 'complete' });
const complete = await completeResource.executable.create({
  runtime: 'github',
  inputSchema: {
    type: 'object',
    required: ['code', 'state', 'pkceVerifier'],
  },
  bindingSchema: {
    clientId: { kind: 'secret', access: 'use' },
    clientSecret: { kind: 'secret', access: 'use' },
    connection: { kind: 'github-connection', access: 'write' },
  },
  program: {
    operation: 'oauth.complete',
    redirectUri: 'https://gateway.company.com/oauth/callback',
  },
});
```

No program declares token response fields or secret writes. The trusted runtime recognizes GitHub's response, stores credential state through the writable connection handle, and returns non-secret metadata only.

## Beginning authorization

The broker authenticates the employee with the host's workforce identity system and starts an OAuth authorization:

```ts
app.get('/oauth/connect/:provider', async (c) => {
  const employee = await authenticateEmployee(c);
  const pending = await pendingAuthorizations.create({
    subject: employee.id,
    provider: c.req.param('provider'),
    scopes: ['repo'],
    pkce: true,
  });

  const events = await initiateExecutable.invoke({
    input: {
      state: pending.state,
      pkceChallenge: pending.pkceChallenge,
    },
    bindings: {
      clientId: githubClientId.id,
    },
  });

  return c.redirect(await singleValue(events));
});
```

The broker creates short-lived, single-use state tied to:

- The authenticated subject
- The authorization executable revision
- The exact redirect URI
- The requested scopes
- A PKCE verifier and challenge
- An expiration time

The authorization URL contains the state value and PKCE challenge but no provider client secret.

## Completing authorization

The callback validates and consumes the pending state, creates an ordinary connection resource, and invokes the completion executable:

```ts
app.get('/oauth/callback', async (c) => {
  const employee = await authenticateEmployee(c);
  const pending = await pendingAuthorizations.consume({
    subject: employee.id,
    state: c.req.query('state')!,
  });

  const connection = await createConnectionResources(employee.id, 'github');
  const events = await completeExecutable.invoke({
    input: {
      code: c.req.query('code')!,
      state: pending.state,
      pkceVerifier: pending.pkceVerifier,
    },
    bindings: {
      clientId: githubClientId.id,
      clientSecret: githubClientSecret.id,
      connection: connection.id,
    },
  });

  const metadata = await singleValue(events);

  return c.json({
    connected: true,
    connectionResourceId: connection.id,
    scope: metadata.scope,
  });
});
```

Connection creation uses the ordinary resource API:

```ts
const connection = await aliceConnections.create({ name: 'github' });
```

The connection begins without credential state. The GitHub runtime exchanges the code, validates the response, and atomically replaces the runtime-private state attached to the connection resource:

```ts
await context.credentials.replace(connection, {
  accessToken: response.access_token,
  refreshToken: response.refresh_token,
  scopes: response.scope,
  expiresAt,
});
```

`context.credentials` is available only to the trusted runtime implementation. It is not part of an executable program and never returns provider credentials through invocation events, repository reads, or browser responses.

## Executable operation

An administrator publishes a GitHub operation that expects the runtime-owned connection:

```ts
const createIssue = await admin.executables.create({
  path: 'tools/github/create-issue',
  runtime: 'github',

  inputSchema: {
    type: 'object',
    required: ['owner', 'repo', 'title'],
    properties: {
      owner: { type: 'string' },
      repo: { type: 'string' },
      title: { type: 'string' },
      body: { type: 'string' },
    },
  },

  bindingSchema: {
    clientId: { kind: 'secret', access: 'use' },
    clientSecret: { kind: 'secret', access: 'use' },
    connection: { kind: 'github-connection', access: 'use' },
  },

  program: {
    operation: 'fetch',
    method: 'POST',
    path: {
      template: '/repos/{owner}/{repo}/issues',
      input: {
        owner: '/owner',
        repo: '/repo',
      },
    },
    body: {
      title: { $input: '/title' },
      body: { $input: '/body' },
    },
  },
});
```

The executable defines the allowed GitHub operation but not an arbitrary origin or authorization header. The runtime restricts requests to GitHub, refreshes the connection when necessary, and injects the access token internally.

## Grant binding

The employee's grant authorizes the executable and use of the client and connection resources:

```ts
await aliceGrant.capabilities.set([
  {
    resourceId: createIssue.id,
    permissions: ['invoke'],
  },
  {
    resourceId: githubClientId.id,
    permissions: ['use'],
  },
  {
    resourceId: githubClientSecret.id,
    permissions: ['use'],
  },
  {
    resourceId: connection.id,
    permissions: ['use'],
  },
]);
```

The invocation supplies the exact connection resource as a binding, and RGAP authorizes it independently. Delegated child grants may narrow executable access, connection access, repositories, rate limits, or expiration, but cannot expand beyond the parent grant.

## Invocation

The employee invokes the operation with their RGAP token:

```ts
const alice = rgap.as(aliceToken);

await alice.resources.get(createIssue.id).invoke({
  input: {
    owner: 'acme',
    repo: 'app',
    title: 'Authentication failure',
  },
  bindings: {
    clientId: githubClientId.id,
    clientSecret: githubClientSecret.id,
    connection: connection.id,
  },
});
```

Invocation performs:

1. Authorization of `invoke` on the exact executable version.
2. Input validation.
3. Resolution and `use` authorization of the client and connection bindings.
4. Validation of the GitHub operation and destination by the runtime.
5. Access-token refresh through the runtime-private connection state when necessary.
6. Credential injection by the runtime.
7. Upstream execution and redacted auditing.

## Connection state

The connection resource exposes non-secret metadata such as provider, scopes, account identity, expiry, and update time. Its runtime-private state contains provider credentials and is readable only by the GitHub runtime.

The runtime refreshes an expired access token as part of `fetch`, atomically stores rotated credentials, and continues the original request. Public invocation events contain API results and connection status metadata, never access or refresh tokens.

## Revocation and lifecycle

Revoking the RGAP grant or token prevents new invocations immediately. Disconnecting invokes the GitHub runtime's ordinary `oauth.revoke` executable when supported, clears the runtime-private credential state, and deletes the connection resource.

An upstream access token already issued to the trusted runtime may remain valid at the provider until its expiry or provider-side revocation. The broker bounds that exposure with short access-token lifetimes, request cancellation, restricted audiences, and mediated invocation.

## Security requirements

The broker enforces:

- Authorization Code flow with PKCE
- Cryptographically random, signed, single-use, expiring state
- Exact redirect URI matching
- Subject binding between authorization start and callback
- Provider and token endpoint allowlists
- Scope and audience downscoping
- Encrypted refresh-token storage or an external vault
- Refresh-token rotation with atomic replacement
- No plaintext credentials in responses, logs, errors, or audit details
- Immutable executable revisions and explicit revision selection
- Destination enforcement before access-token attachment
