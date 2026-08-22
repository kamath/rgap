/**
 * A scratchpad. It is here to answer "what does the model do about this?", so edit it freely:
 * arrange resources, grants, and tokens, then print what authorization says about them.
 *
 * `pnpm scratch` runs this file against examples/scratch.db.
 */
import { fileURLToPath } from 'node:url';
import { resourceId, resourcePath, type Permission, type ResourceId, type TokenValue } from '@rgap/core';
import { SqliteRgapStore } from '@rgap/sqlite';

const store = new SqliteRgapStore({ url: fileURLToPath(new URL('scratch.db', import.meta.url)) });
const root = store.admin();

// Every run starts from an empty store. Remove this to keep what the last run wrote.
await root.reset();

const acme = await root.resources.create({ name: 'acme-company' });
const adminGrant = await root.grants.create({
  name: 'Acme admin', capabilities: [], expiresAt: null,
});
await adminGrant.capabilities.set([
  {
    target: { type: 'resource', resourceId: acme.id },
    permissions: ['read', 'write', 'invoke', 'move', 'delete'],
    descendants: true,
  },
]);
const adminToken = await adminGrant.tokens.create({ label: 'admin' });
const admin = store.as(adminToken.value);

const drive = await (await admin.resources.get(acme.id)).create({ name: 'drive' });
const notes = await drive.create({ name: 'notes' });
const secret = await (await admin.resources.get(acme.id)).create({ name: 'secret' });

const aliceToken = await (await admin.grants.get(adminGrant.id)).tokens.create({ label: 'alice cli' });
const alice = store.as(aliceToken.value);

// Alice delegates through her token-authorized plane, so the child can only be narrower than her grant.
const readerGrant = await (await alice.grants.get(adminGrant.id)).create({
  name: 'Drive read', capabilities: [], expiresAt: null,
});
await readerGrant.capabilities.set([
  { target: { type: 'path', path: 'acme-company/drive' }, permissions: ['read'], descendants: true },
]);

const bobToken = await readerGrant.tokens.create({ label: 'bob' });

const { resources } = await admin.readState();
const path = (id: ResourceId) => resourcePath(resources, id);

const check = async (label: string, token: TokenValue, resourceId: ResourceId, permission: Permission) => {
  const decision = await admin.authorize(token, resourceId, permission);
  const verdict = decision.allowed ? 'allow' : 'deny ';
  console.log(`${verdict}  ${label.padEnd(6)} ${permission.padEnd(7)} ${path(resourceId).padEnd(18)} ${decision.detail}`);
};

await check('alice', aliceToken.value, notes.id, 'read');
await check('bob', bobToken.value, notes.id, 'read');
await check('bob', bobToken.value, notes.id, 'write');
await check('bob', bobToken.value, secret.id, 'read');

for (const [label, token] of [['alice', aliceToken.value], ['bob', bobToken.value]] as const) {
  const authority = await admin.inspectToken(token);
  console.log(`\n${label}: ${authority.detail}`);
  Object.entries(authority.permissions).forEach(([id, held]) => {
    console.log(`  ${path(resourceId(id)).padEnd(18)} ${held.join(' ')}`);
  });
}

console.log(await root.readState());

store.close();
