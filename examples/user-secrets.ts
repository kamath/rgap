import { z } from 'zod';
import type { InvokeRuntime } from '@rgap/core';
import { SqliteRgapStore } from '@rgap/sqlite';

// Replace this adapter with a client for the deployment's secret store.
const values = new Map([['users/alice/github-token', 'example-user-secret']]);
const secretStore = {
  async get(reference: string) {
    return values.get(reference);
  },
};

const githubToken: InvokeRuntime<null, string> = {
  inputSchema: z.null(),
  outputSchema: z.string(),
  async invoke() {
    const value = await secretStore.get('users/alice/github-token');
    if (value === undefined) throw new Error('Secret is unavailable.');
    return value;
  },
};

const store = new SqliteRgapStore({
  url: ':memory:',
  runtimes: { githubToken },
});

try {
  const admin = store.admin();
  const secret = await admin.resources.create({
    name: 'users/alice/secrets/github-token',
  });
  await secret.executable.set({ runtime: 'githubToken' });

  const grant = await admin.grants.create({
    name: 'users/alice/secret-reader',
    resources: [{ id: secret.id, permissions: ['invoke'] }],
    expiresAt: null,
  });
  const token = await grant.tokens.create({ label: 'secret-reader' });
  const caller = store.as(token.value);
  const authorizedSecret = await caller.resources.get(secret.id);

  let value: string | undefined;
  for await (const event of authorizedSecret.invoke({ input: null })) {
    if (event.type === 'data') value = z.string().parse(event.value);
  }

  // Use the value without writing it to logs, model context, or telemetry.
  console.log(`Secret fetched: ${value !== undefined}`);
} finally {
  store.close();
}
