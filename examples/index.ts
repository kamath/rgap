/**
 * A scratchpad. It is here to answer "what does the model do about this?", so edit it freely:
 * arrange resources, grants, and tokens, then print what authorization says about them.
 *
 * `pnpm scratch` runs this file against examples/scratch.db.
 */
import { fileURLToPath } from 'node:url';
import { resourcePath, type Permission } from '@rgap/core';
import { SqliteRgapRepository } from '@rgap/sqlite';

const repository = new SqliteRgapRepository({ url: fileURLToPath(new URL('scratch.db', import.meta.url)) });

// Every run starts from an empty store. Remove this to keep what the last run wrote.
await repository.reset();

await repository.createResource({ name: 'acme', parentId: null, movePolicy: 'normal', deletePolicy: 'revoke' });


const acme = await repository.createResource({ name: 'acme', parentId: null, movePolicy: 'normal', deletePolicy: 'revoke' });
const drive = await repository.createResource({ name: 'drive', parentId: acme.id, movePolicy: 'normal', deletePolicy: 'revoke' });
const notes = await repository.createResource({ name: 'notes', parentId: drive.id, movePolicy: 'normal', deletePolicy: 'revoke' });
const secret = await repository.createResource({ name: 'secret', parentId: acme.id, movePolicy: 'normal', deletePolicy: 'revoke' });

const admin = await repository.createGrant({
  name: 'Acme admin', subject: 'alice', parentId: null, capabilities: [], expiresAt: null,
});
await repository.setCapabilities(admin.id, [
  {
    resourceId: acme.id,
    permissions: ['read', 'write', 'invoke', 'move', 'delete'],
    descendants: true,
    relocation: 'revoke_on_scope_exit',
  },
]);

// Delegated from the grant above, so it can only be narrower than it.
const reader = await repository.createGrant({
  name: 'Drive read', subject: 'bob', parentId: admin.id, capabilities: [], expiresAt: null,
});
await repository.setCapabilities(reader.id, [
  { resourceId: drive.id, permissions: ['read'], descendants: true, relocation: 'revoke_on_scope_exit' },
]);

const alice = await repository.issueToken(admin.id, 'alice cli');
const bob = await repository.issueToken(reader.id, 'bob cli');

const { resources } = await repository.readState();
const path = (id: string) => resourcePath(resources, id);

const check = async (label: string, token: string, resourceId: string, permission: Permission) => {
  const decision = await repository.authorize(token, resourceId, permission);
  const verdict = decision.allowed ? 'allow' : 'deny ';
  console.log(`${verdict}  ${label.padEnd(6)} ${permission.padEnd(7)} ${path(resourceId).padEnd(18)} ${decision.detail}`);
};

await check('alice', alice.value, notes.id, 'read');
await check('bob', bob.value, notes.id, 'read');
await check('bob', bob.value, notes.id, 'write');
await check('bob', bob.value, secret.id, 'read');

for (const [label, token] of [['alice', alice.value], ['bob', bob.value]] as const) {
  const authority = await repository.inspectToken(token);
  console.log(`\n${label}: ${authority.detail}`);
  Object.entries(authority.permissions).forEach(([id, held]) => {
    console.log(`  ${path(id).padEnd(18)} ${held.join(' ')}`);
  });
}

repository.close();
