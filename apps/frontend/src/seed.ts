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
        id: 'coordinator', name: 'Coordinator', parentId: null,
        capabilities: [
          resourceCap('search-files'),
          pathCap('Acme/MCP servers/Slack/Tools/search_messages'),
          pathCap('Acme/MCP servers/GitHub/Tools/create_issue'),
          pathCap('Acme/MCP servers/GitHub/Tools/archive_issue'),
        ],
        expiresAt: '2027-08-21T23:00:00.000Z', revokedAt: null,
      },
      researcher: {
        id: 'researcher', name: 'Researcher', parentId: 'coordinator',
        capabilities: [resourceCap('search-files'), pathCap('Acme/MCP servers/Slack/Tools/search_messages')],
        expiresAt: '2027-08-21T22:00:00.000Z', revokedAt: null,
      },
      summarizer: {
        id: 'summarizer', name: 'Summarizer', parentId: 'researcher',
        capabilities: [resourceCap('search-files')],
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
  return { id, parentId, name, deletedAt: null };
}

const resourceCap = (resourceId: string): Capability => ({
  target: { type: 'resource', resourceId },
  permissions: ['invoke'],
  descendants: false,
});

const pathCap = (path: string): Capability => ({
  target: { type: 'path', path },
  permissions: ['invoke'],
  descendants: false,
});
