import type { Capability, Resource, State } from './domain';

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
