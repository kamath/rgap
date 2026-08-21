import type { Capability, State } from '@rgap/core';

export const demoToken = 'rgap_demo_coordinator';

export function seed(): State {
  return {
    resources: Object.fromEntries([
      resource('acme', null, 'Acme'),
      resource('mcp', 'acme', 'MCP servers'),
      resource('drive', 'mcp', 'Google Drive'),
      resource('drive-tools', 'drive', 'Tools'),
      resource('search-files', 'drive-tools', 'search_files'),
      resource('read-file', 'drive-tools', 'read_file'),
      resource('slack', 'mcp', 'Slack'),
      resource('slack-tools', 'slack', 'Tools'),
      resource('search-messages', 'slack-tools', 'search_messages'),
      resource('post-message', 'slack-tools', 'post_message'),
      resource('github', 'mcp', 'GitHub'),
      resource('github-tools', 'github', 'Tools'),
      resource('read-issue', 'github-tools', 'read_issue'),
      resource('create-issue', 'github-tools', 'create_issue'),
    ].map((item) => [item.id, item])),
    grants: {
      coordinator: {
        id: 'coordinator', name: 'Coordinator', subject: 'coordinator agent', parentId: null,
        capabilities: [cap('search-files'), cap('search-messages'), cap('create-issue')],
        expiresAt: '2027-08-21T23:00:00.000Z', revokedAt: null,
      },
      researcher: {
        id: 'researcher', name: 'Researcher', subject: 'research sub-agent', parentId: 'coordinator',
        capabilities: [cap('search-files'), cap('search-messages')],
        expiresAt: '2027-08-21T22:00:00.000Z', revokedAt: null,
      },
      summarizer: {
        id: 'summarizer', name: 'Summarizer', subject: 'summarizing sub-agent', parentId: 'researcher',
        capabilities: [cap('search-files')],
        expiresAt: '2027-08-21T21:00:00.000Z', revokedAt: null,
      },
    },
    tokens: {
      demo: {
        id: 'demo', grantId: 'coordinator', label: 'coordinator demo',
        hash: 'b528aaf0496a7f1b670eaf73987ee9237eaddbbefa1ade4844e5d318d4d35bc3',
        expiresAt: '2027-08-21T23:00:00.000Z', revokedAt: null,
      },
    },
    audit: [{
      id: 'welcome', at: '2026-08-21T16:00:00.000Z', action: 'example.load',
      target: 'acme', result: 'recorded', detail: 'Loaded the MCP delegation example.',
    }],
  };
}

function resource(id: string, parentId: string | null, name: string) {
  return { id, parentId, name, movePolicy: 'normal' as const, deletePolicy: 'revoke' as const, deletedAt: null };
}

function cap(resourceId: string): Capability {
  return {
    resourceId, permissions: ['invoke'],
    descendants: false, relocation: 'revoke_on_scope_exit' as const,
  };
}
