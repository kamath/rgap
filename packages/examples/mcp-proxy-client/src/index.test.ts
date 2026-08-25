import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  clientClose: vi.fn(),
  clientConnect: vi.fn(),
  clientConstructor: vi.fn(),
  transportConstructor: vi.fn(),
}));

vi.mock('@modelcontextprotocol/client', () => ({
  Client: class {
    constructor(info: unknown) {
      mocks.clientConstructor(info);
    }

    connect(transport: unknown) {
      return mocks.clientConnect(transport);
    }

    close() {
      return mocks.clientClose();
    }
  },
  StreamableHTTPClientTransport: class {
    constructor(url: URL, options: unknown) {
      mocks.transportConstructor(url, options);
    }
  },
}));

import { createMcpProxyClient } from './index';

describe('createMcpProxyClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.clientConnect.mockResolvedValue(undefined);
    mocks.clientClose.mockResolvedValue(undefined);
  });

  it('connects an authenticated client to a path-prefixed proxy', async () => {
    const client = await createMcpProxyClient({
      proxyUrl: new URL('https://example.com/integrations/gmail'),
      connectionId: 'resource/with spaces',
      rgapToken: 'rgap-secret',
      clientInfo: { name: 'agent', version: '1.0.0' },
    });

    expect(mocks.clientConstructor).toHaveBeenCalledWith({
      name: 'agent',
      version: '1.0.0',
    });
    expect(mocks.transportConstructor).toHaveBeenCalledWith(
      new URL('https://example.com/integrations/gmail/mcp/resource%2Fwith%20spaces'),
      {
        requestInit: {
          headers: { Authorization: 'Bearer rgap-secret' },
        },
      },
    );
    expect(mocks.clientConnect).toHaveBeenCalledOnce();
    expect(client).toBeDefined();
  });

  it('closes the client when initialization fails', async () => {
    mocks.clientConnect.mockRejectedValue(new Error('initialize failed'));

    await expect(createMcpProxyClient({
      proxyUrl: new URL('https://example.com'),
      connectionId: 'resource_1',
      rgapToken: 'token',
      clientInfo: { name: 'agent', version: '1.0.0' },
    })).rejects.toThrow('initialize failed');

    expect(mocks.clientClose).toHaveBeenCalledOnce();
  });
});
