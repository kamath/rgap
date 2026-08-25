import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpProxyClient } from './index';

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(
    (server) => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  ));
});

describe('createMcpProxyClient integration', () => {
  it('sends authenticated initialize lifecycle messages over POST', async () => {
    const methods: string[] = [];
    const authorizations: (string | undefined)[] = [];
    const server = createServer(async (request, response) => {
      authorizations.push(request.headers.authorization);
      if (request.method !== 'POST') {
        response.writeHead(405, { Allow: 'POST' }).end();
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const message = JSON.parse(Buffer.concat(chunks).toString()) as {
        id?: string | number;
        method: string;
        params?: { protocolVersion?: string };
      };
      methods.push(message.method);
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        result: {
          protocolVersion: message.params?.protocolVersion,
          capabilities: {},
          serverInfo: { name: 'test-proxy', version: '1.0.0' },
        },
      }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test address.');

    const client = await createMcpProxyClient({
      proxyUrl: new URL(`http://127.0.0.1:${address.port}/gateway`),
      connectionId: 'connection_1',
      rgapToken: 'rgap-token',
      clientInfo: { name: 'test-client', version: '1.0.0' },
    });
    await client.close();

    expect(methods).toEqual(['initialize', 'notifications/initialized']);
    expect(authorizations).toEqual(['Bearer rgap-token', 'Bearer rgap-token']);
  });
});
