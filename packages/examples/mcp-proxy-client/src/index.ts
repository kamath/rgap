import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

export type McpProxyClientInfo = {
  name: string;
  version: string;
};

export type CreateMcpProxyClientOptions = {
  proxyUrl: URL;
  connectionId: string;
  rgapToken: string;
  clientInfo: McpProxyClientInfo;
};

export async function createMcpProxyClient(
  options: CreateMcpProxyClientOptions,
) {
  const endpoint = proxyEndpoint(options.proxyUrl, options.connectionId);
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: {
      headers: {
        Authorization: `Bearer ${options.rgapToken}`,
      },
    },
  });
  const client = new Client(options.clientInfo);
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

function proxyEndpoint(proxyUrl: URL, connectionId: string) {
  const baseUrl = new URL(proxyUrl);
  baseUrl.search = '';
  baseUrl.hash = '';
  if (!baseUrl.pathname.endsWith('/')) baseUrl.pathname += '/';
  return new URL(`mcp/${encodeURIComponent(connectionId)}`, baseUrl);
}
