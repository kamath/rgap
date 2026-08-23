import { z } from 'zod';
import type { InvokeRuntime } from '@rgap/core';
import { SqliteRgapStore } from '@rgap/sqlite';

interface SecretStore {
  get(reference: string): Promise<string | undefined>;
}

const SecretOutputSchema = z.object({ value: z.string() });

function revealSecret(
  secretStore: SecretStore,
  reference: string,
): InvokeRuntime<null, z.infer<typeof SecretOutputSchema>> {
  return {
    inputSchema: z.null(),
    outputSchema: SecretOutputSchema,
    async invoke() {
      const value = await secretStore.get(reference);
      if (value === undefined) throw new Error('Secret is unavailable.');
      return { value };
    },
  };
}

// Replace this adapter with a client for the deployment's secret store.
const values = new Map([['users/alice/github-token', 'example-user-secret']]);
const secretStore: SecretStore = {
  async get(reference) {
    return values.get(reference);
  },
};

const store = new SqliteRgapStore({
  url: ':memory:',
  runtimes: {
    revealGithubToken: revealSecret(secretStore, 'users/alice/github-token'),
  },
});

try {
  const admin = store.admin();
  const secret = await admin.resources.create({
    name: 'users/alice/secrets/github-token',
  });
  await secret.executable.set({ runtime: 'revealGithubToken' });

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
    if (event.type === 'data') value = SecretOutputSchema.parse(event.value).value;
  }

  // Use the value without writing it to logs, model context, or telemetry.
  console.log(`Secret fetched: ${value !== undefined}`);
} finally {
  store.close();
}
