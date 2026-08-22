/**
 * A scratchpad. It is here to answer "what does the model do about this?", so edit it freely:
 * arrange resources, grants, and tokens, then print what authorization says about them.
 *
 * `pnpm scratch` runs this file against examples/scratch.db.
 */
import { fileURLToPath } from 'node:url';
import { resourcePath, type Permission } from '@rgap/core';
import { SqliteRgapStore } from '@rgap/sqlite';

const store = new SqliteRgapStore({ url: fileURLToPath(new URL('scratch.db', import.meta.url)) });
const root = store.admin();

// Every run starts from an empty store. Remove this to keep what the last run wrote.
await root.reset();



const acme = await root.createResource({ name: 'acme-company', parentId: null });

const adminGrant = await root.createGrant({
  name: 'Acme admin', parentId: acme.id, capabilities: [], expiresAt: null,
});
await root.setCapabilities(adminGrant.id, [
  {
    target: { type: 'resource', resourceId: acme.id },
    permissions: ['read', 'write', 'invoke', 'move', 'delete'],
    descendants: true,
  },
]);
const admin = store.as(adminGrant.id);

const drive = await admin.createResource({ name: 'drive', parentId: acme.id });
const notes = await admin.createResource({ name: 'notes', parentId: drive.id });
const secret = await admin.createResource({ name: 'secret', parentId: acme.id });

const alice = await admin.issueToken(adminGrant.id, 'alice cli');
const aliceRepository = store.as(alice.value);

// Alice delegates through her token-authorized plane, so the child can only be narrower than her grant.
const reader = await aliceRepository.createGrant({
  name: 'Drive read', parentId: adminGrant.id, capabilities: [], expiresAt: null,
});
await aliceRepository.setCapabilities(reader.id, [
  { target: { type: 'path', path: 'acme/drive' }, permissions: ['read'], descendants: true },
]);

const bob = await aliceRepository.issueToken(reader.id, 'bob cli');

const { resources } = await admin.readState();
const path = (id: string) => resourcePath(resources, id);

const check = async (label: string, token: string, resourceId: string, permission: Permission) => {
  const decision = await admin.authorize(token, resourceId, permission);
  const verdict = decision.allowed ? 'allow' : 'deny ';
  console.log(`${verdict}  ${label.padEnd(6)} ${permission.padEnd(7)} ${path(resourceId).padEnd(18)} ${decision.detail}`);
};

await check('alice', alice.value, notes.id, 'read');
await check('bob', bob.value, notes.id, 'read');
await check('bob', bob.value, notes.id, 'write');
await check('bob', bob.value, secret.id, 'read');

for (const [label, token] of [['alice', alice.value], ['bob', bob.value]] as const) {
  const authority = await admin.inspectToken(token);
  console.log(`\n${label}: ${authority.detail}`);
  Object.entries(authority.permissions).forEach(([id, held]) => {
    console.log(`  ${path(id).padEnd(18)} ${held.join(' ')}`);
  });
}

store.close();
