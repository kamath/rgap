import { grantId, resourceId, tokenHash, tokenId, type Capability, type State } from '@rgap/core';

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
        id: grantId('coordinator'), name: 'Coordinator', parentId: null,
        capabilities: [
          resourceCap('search-files'),
          pathCap('Acme/MCP servers/Slack/Tools/search_messages'),
          pathCap('Acme/MCP servers/GitHub/Tools/create_issue'),
          pathCap('Acme/MCP servers/GitHub/Tools/archive_issue'),
        ],
        expiresAt: '2027-08-21T23:00:00.000Z', revokedAt: null,
      },
      researcher: {
        id: grantId('researcher'), name: 'Researcher', parentId: grantId('coordinator'),
        capabilities: [resourceCap('search-files'), pathCap('Acme/MCP servers/Slack/Tools/search_messages')],
        expiresAt: '2027-08-21T22:00:00.000Z', revokedAt: null,
      },
      summarizer: {
        id: grantId('summarizer'), name: 'Summarizer', parentId: grantId('researcher'),
        capabilities: [resourceCap('search-files')],
        expiresAt: '2027-08-21T21:00:00.000Z', revokedAt: null,
      },
    },
    tokens: {
      demo: {
        id: tokenId('demo'), grantId: grantId('coordinator'), label: 'coordinator demo',
        hash: tokenHash('b528aaf0496a7f1b670eaf73987ee9237eaddbbefa1ade4844e5d318d4d35bc3'),
        expiresAt: '2027-08-21T23:00:00.000Z', revokedAt: null,
      },
    },
    audit: [{
      id: 'welcome', at: '2026-08-21T16:00:00.000Z', action: 'example.load',
      target: resourceId('acme'), result: 'recorded', detail: 'Loaded the MCP delegation example.',
    }],
  };
}

function resource(id: string, parent: string | null, name: string) {
  return { id: resourceId(id), parentId: parent ? resourceId(parent) : null, name, deletedAt: null };
}

const resourceCap = (id: string): Capability => ({
  resourceId: resourceId(id),
  permissions: ['invoke'],
});

const pathCap = (path: string): Capability => ({
  path,
  permissions: ['invoke'],
});
