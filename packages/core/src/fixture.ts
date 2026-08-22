import {
  authorize, inspectAuthority, executableRevisionId, grantId, resourceId, tokenHash, tokenId, tokenValue,
  type Capability, type Resource, type State,
} from './domain';
import { paginateRecords, repositoryFrom, type RgapCommands } from './repository';

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
        id: grantId('coordinator'), name: 'Coordinator', parentId: null,
        capabilities: [cap('search-files'), cap('create-issue')],
        expiresAt: '2027-08-21T23:00:00.000Z', revokedAt: null,
      },
      researcher: {
        id: grantId('researcher'), name: 'Researcher', parentId: grantId('coordinator'),
        capabilities: [cap('search-files')],
        expiresAt: '2027-08-21T22:00:00.000Z', revokedAt: null,
      },
    },
    tokens: {
      demo: {
        id: tokenId('demo'), grantId: grantId('coordinator'), label: 'demo',
        hash: tokenHash('b528aaf0496a7f1b670eaf73987ee9237eaddbbefa1ade4844e5d318d4d35bc3'),
        expiresAt: '2027-08-21T23:00:00.000Z', revokedAt: null,
      },
    },
    executables: {},
    executableRevisions: {},
    audit: [],
  };
}

const resource = (id: string, parent: string | null): Resource => ({
  id: resourceId(id), parentId: parent ? resourceId(parent) : null, name: id, deletedAt: null,
});

const cap = (id: string): Capability => ({
  resourceId: resourceId(id), permissions: ['invoke'],
});

/** A call the guard forwarded to the command sink, in the order the guard made it. */
export type RecordedCall = { method: string; args: unknown[] };

/**
 * A command sink that answers the guard's reads from a fixed state and records its commands.
 *
 * The guard decides which commands may run; it does not compute state transitions. Recording the
 * forwarded call rather than applying it keeps a guard test about the decision alone, and keeps it
 * independent of any repository implementation.
 */
export function stubCommands(state: State, at: string) {
  const calls: RecordedCall[] = [];
  const record = <T>(method: string, args: unknown[], result: T) => {
    calls.push({ method, args });
    return Promise.resolve(result);
  };
  const resourceStub = (id: Resource['id'], parentId: Resource['parentId']): Resource =>
    ({ id, parentId, name: id, deletedAt: null });

  const commands: RgapCommands = {
    getResource: (id) => Promise.resolve(state.resources[id]),
    listResources: (query = {}) => Promise.resolve(paginateRecords(
      Object.values(state.resources)
        .filter((item) => !item.deletedAt && (query.parentId === undefined || item.parentId === query.parentId))
        .sort((left, right) => left.id.localeCompare(right.id)),
      query,
    )),
    getGrant: (id) => Promise.resolve(state.grants[id]),
    listGrants: (query = {}) => Promise.resolve(paginateRecords(
      Object.values(state.grants)
        .filter((item) => query.parentId === undefined || item.parentId === query.parentId)
        .sort((left, right) => left.id.localeCompare(right.id)),
      query,
    )),
    getToken: (id) => Promise.resolve(state.tokens[id]),
    listTokens: (query = {}) => Promise.resolve(paginateRecords(
      Object.values(state.tokens)
        .filter((item) => query.grantId === undefined || item.grantId === query.grantId)
        .sort((left, right) => left.id.localeCompare(right.id)),
      query,
    )),
    listAudit: (query = {}) => Promise.resolve(paginateRecords(state.audit, query)),
    // Tests treat the bearer as the stored hash, so the stub re-brands rather than hashing.
    authorize: (token, id, permission) => Promise.resolve(authorize(state, tokenHash(token), id, permission, at)),
    inspectToken: (token) => Promise.resolve(inspectAuthority(state, tokenHash(token), at)),
    createResource: (input) => record('createResource', [input], { ...input, id: resourceId('created'), deletedAt: null }),
    moveResource: (id, parentId) => record('moveResource', [id, parentId], resourceStub(id, parentId)),
    deleteResource: (id) => record('deleteResource', [id], undefined),
    getExecutable: (id) => Promise.resolve(state.executables[id]),
    getExecutableRevision: (id) => Promise.resolve(state.executableRevisions[id]),
    listExecutableRevisions: (id) => Promise.resolve(
      Object.values(state.executableRevisions).filter((revision) => revision.resourceId === id),
    ),
    publishExecutable: (id, input) => record('publishExecutable', [id, input], {
      ...input, id: executableRevisionId('revision'), resourceId: id, createdAt: at,
    }),
    deleteExecutable: (id) => record('deleteExecutable', [id], undefined),
    invoke: (id, input) => {
      calls.push({ method: 'invoke', args: [id, input] });
      return (async function* () {
        yield { type: 'done' as const };
      })();
    },
    createGrant: (input) => record('createGrant', [input], { ...input, id: grantId('created'), revokedAt: null }),
    setCapabilities: (id, capabilities) =>
      record('setCapabilities', [id, capabilities], { ...state.grants[id], capabilities }),
    issueToken: (id, label) => record('issueToken', [id, label], {
      record: {
        id: tokenId('issued'), grantId: id, label, hash: tokenHash('issued-hash'), expiresAt: null, revokedAt: null,
      },
      value: tokenValue('issued-value'),
    }),
    revokeToken: (id) => record('revokeToken', [id], undefined),
    revokeGrant: (id) => record('revokeGrant', [id], undefined),
    reset: () => record('reset', [], undefined),
  };
  return { commands, calls };
}
