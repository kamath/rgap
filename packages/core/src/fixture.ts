import { authorize, inspectAuthority, type Capability, type Resource, type State } from './domain';
import type { RgapRepository } from './repository';

export function fixture(): State {
  const resources = [
    resource('acme', null), resource('drive', 'acme'), resource('search-files', 'drive'), resource('read-file', 'drive'),
    resource('slack', 'acme'), resource('slack-tools', 'slack'), resource('post-message', 'slack-tools'),
    resource('create-issue', 'acme'),
  ];
  return {
    resources: Object.fromEntries(resources.map((item) => [item.id, item])),
    grants: {
      coordinator: {
        id: 'coordinator', name: 'Coordinator', subject: 'agent', parentId: null,
        capabilities: [cap('search-files'), cap('create-issue')],
        expiresAt: '2027-08-21T23:00:00.000Z', revokedAt: null,
      },
      researcher: {
        id: 'researcher', name: 'Researcher', subject: 'sub-agent', parentId: 'coordinator',
        capabilities: [cap('search-files')],
        expiresAt: '2027-08-21T22:00:00.000Z', revokedAt: null,
      },
    },
    tokens: {
      demo: {
        id: 'demo', grantId: 'coordinator', label: 'demo',
        hash: 'b528aaf0496a7f1b670eaf73987ee9237eaddbbefa1ade4844e5d318d4d35bc3',
        expiresAt: '2027-08-21T23:00:00.000Z', revokedAt: null,
      },
    },
    audit: [],
  };
}

const resource = (id: string, parentId: string | null): Resource => ({
  id, parentId, name: id, movePolicy: 'normal', deletePolicy: 'revoke', deletedAt: null,
});

const cap = (resourceId: string): Capability => ({
  resourceId, permissions: ['invoke'], descendants: false, relocation: 'revoke_on_scope_exit',
});

/** A call the guard forwarded to the repository, in the order the guard made it. */
export type RecordedCall = { method: string; args: unknown[] };

/**
 * A repository that answers the guard's reads from a fixed state and records its commands.
 *
 * The guard decides which commands may run; it does not compute state transitions. Recording the
 * forwarded call rather than applying it keeps a guard test about the decision alone, and keeps it
 * independent of any repository implementation.
 */
export function stubRepository(state: State, at: string) {
  const calls: RecordedCall[] = [];
  const record = <T>(method: string, args: unknown[], result: T) => {
    calls.push({ method, args });
    return Promise.resolve(result);
  };
  const resourceStub = (id: string, parentId: string | null): Resource =>
    ({ id, parentId, name: id, movePolicy: 'normal', deletePolicy: 'revoke', deletedAt: null });

  const repository: RgapRepository = {
    readState: () => Promise.resolve(state),
    authorize: (token, resourceId, permission) => Promise.resolve(authorize(state, token, resourceId, permission, at)),
    inspectToken: (token) => Promise.resolve(inspectAuthority(state, token, at)),
    createResource: (input) => record('createResource', [input], { ...input, id: 'created', deletedAt: null }),
    moveResource: (id, parentId) => record('moveResource', [id, parentId], resourceStub(id, parentId)),
    deleteResource: (id) => record('deleteResource', [id], undefined),
    createGrant: (input) => record('createGrant', [input], { ...input, id: 'created', revokedAt: null }),
    setCapabilities: (grantId, capabilities) =>
      record('setCapabilities', [grantId, capabilities], { ...state.grants[grantId], capabilities }),
    issueToken: (grantId, label) => record('issueToken', [grantId, label], {
      record: { id: 'issued', grantId, label, hash: 'issued-hash', expiresAt: null, revokedAt: null },
      value: 'issued-value',
    }),
    revokeToken: (id) => record('revokeToken', [id], undefined),
    revokeGrant: (id) => record('revokeGrant', [id], undefined),
    reset: () => record('reset', [], undefined),
  };
  return { repository, calls };
}
