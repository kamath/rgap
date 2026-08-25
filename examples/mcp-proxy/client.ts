import { createMcpProxyClient } from '@rgap/mcp-proxy-client';
import { z } from 'zod';

const proxyUrl = new URL(process.env.MCP_PROXY_URL ?? 'http://127.0.0.1:3003');
const connectionId = required('MCP_CONNECTION_ID');
const rgapToken = required('RGAP_TOKEN');

const client = await createMcpProxyClient({
  proxyUrl,
  connectionId,
  rgapToken,
  clientInfo: {
    name: 'rgap-mcp-proxy-example',
    version: '0.0.0',
  },
});

try {
  const tools = await client.request(
    { method: 'tools/list', params: {} },
    z.unknown(),
  );
  console.log(tools);
} finally {
  await client.close();
}

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
