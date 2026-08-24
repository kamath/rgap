import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import type { InvokeRuntime } from '@rgap/core';
import {
  SqliteCredentialStore,
  type CredentialStore,
} from '@rgap/local-credential-store';
import { createApp } from '@rgap/server';
import { SqliteRgapStore } from '@rgap/sqlite';
import { z } from 'zod';

const directory = fileURLToPath(new URL('.', import.meta.url));
const secretStore: CredentialStore<string> = new SqliteCredentialStore<string>(
  `${directory}/secrets.db`,
);

type GithubProfile = { login: string };

const githubProfile: InvokeRuntime<{ credential: string }, GithubProfile> = {
  inputSchema: z.object({ credential: z.string() }),
  outputSchema: z.object({ login: z.string() }),
  async invoke({ input }) {
    const token = await secretStore.get(input.credential);
    if (token === undefined) throw new Error('Credential is unavailable.');
    return mockGithubProfile(token);
  },
};

const profileSummary: InvokeRuntime<{ profile: string }, string> = {
  inputSchema: z.object({ profile: z.string() }),
  outputSchema: z.string(),
  async invoke({ input, invoke }) {
    const profile = await invoke.one<GithubProfile>(input.profile, { input: {} });
    return `GitHub user: ${profile.login}`;
  },
};

const store = new SqliteRgapStore({
  url: `${directory}/rgap.db`,
  runtimes: { githubProfile, profileSummary },
});

const admin = store.admin();
await admin.reset();

const githubToken = await admin.resources.create({
  name: 'users/alice/secrets/github-token',
});
const demoToken = process.env.DEMO_SECRET ?? 'example-user-secret';
await secretStore.set(githubToken.id, demoToken);

const profile = await admin.resources.create({
  name: 'users/alice/functions/github-profile',
  executable: {
    runtime: 'githubProfile',
    bind: { credential: githubToken.id },
  },
});

const scripts = await admin.resources.create({
  name: 'users/alice/scripts',
});
const author = await admin.grants.create({
  name: 'users/alice/script-author',
  bindings: [
    { id: scripts.id, permissions: ['write', 'invoke'] },
    { id: profile.id, permissions: ['bind'] },
  ],
  expiresAt: null,
});
const authorToken = await author.tokens.create({ label: 'script-author' });

const alice = store.as(authorToken.value);
const script = await (await alice.resources.get(scripts.id)).create({
  name: 'profile-summary',
  executable: {
    runtime: 'profileSummary',
    bind: { profile: profile.id },
  },
});

const actingAuthor = await alice.grants.get(author.id);
const consumer = await actingAuthor.create({
  name: 'profile-consumer',
  bindings: [{ id: script.id, permissions: ['invoke'] }],
  expiresAt: null,
});
const consumerToken = await consumer.tokens.create({ label: 'consumer' });
const tokenPath = `${directory}/script-invoker.token`;
writeFileSync(tokenPath, consumerToken.value, { mode: 0o600 });

const app = createApp({
  store,
  adminToken: process.env.RGAP_ADMIN_TOKEN ?? 'test',
});
const port = Number(process.env.PORT ?? 3002);
const server = serve({ fetch: app.fetch, port }, ({ port: listeningPort }) => {
  console.log(`Secret-store example listening on http://localhost:${listeningPort}`);
  console.log(`Bearer token written to ${tokenPath}`);
  console.log(`User-created script resource: ${script.id}`);
});

function close() {
  server.close(async () => {
    store.close();
    await secretStore.close();
  });
}

process.once('SIGINT', close);
process.once('SIGTERM', close);

function mockGithubProfile(token: string): GithubProfile {
  if (token !== demoToken) throw new Error('GitHub authentication failed.');
  return { login: 'alice' };
}
