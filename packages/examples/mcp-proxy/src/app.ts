import {
  resourceId,
  RgapError,
  tokenValue,
  type RgapStore,
} from '@rgap/core';
import { ProtocolError } from '@modelcontextprotocol/client';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { McpProxyRuntime } from './runtime';

const JsonRpcIdSchema = z.union([z.string(), z.number()]);
const JsonRpcMessageSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: JsonRpcIdSchema.optional(),
  method: z.string().min(1),
  params: z.record(z.string(), z.unknown()).optional(),
});
const InitializeParamsSchema = z.object({
  protocolVersion: z.string().min(1),
}).passthrough();
const streamableHttpVersions = new Set([
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
]);

type JsonRpcId = z.infer<typeof JsonRpcIdSchema>;

export type McpProxyAppOptions = {
  mcp: McpProxyRuntime;
  store: RgapStore;
};

export function createMcpProxyApp({ mcp, store }: McpProxyAppOptions) {
  const app = new Hono();

  app.get('/oauth/client-metadata.json', (context) => {
    const document = mcp.clientMetadataDocument();
    if (!document) return context.notFound();
    context.header('Cache-Control', 'public, max-age=3600');
    return context.json(document);
  });

  app.get('/oauth/callback', async (context) => {
    context.header('Referrer-Policy', 'no-referrer');
    const state = context.req.query('state');
    if (!state) return context.text('OAuth callback validation failed.', 400);
    try {
      const status = await mcp.finishAuthorization(
        state,
        new URL(context.req.url),
      );
      if (status.status !== 'connected') {
        return context.text('OAuth authorization did not complete.', 409);
      }
      return context.html(
        '<h1>MCP authorization complete</h1><p>You may close this window.</p>',
      );
    } catch {
      console.error('OAuth callback failed.');
      return context.text('OAuth callback validation failed.', 400);
    }
  });

  app.post('/mcp/:connectionId', async (context) => {
    const origin = context.req.header('origin');
    if (origin && origin !== mcp.publicBaseUrl.origin) {
      return context.json(jsonRpcError(null, -32003, 'Origin is not allowed.'), 403);
    }
    const bearer = bearerToken(context.req.header('authorization'));
    if (!bearer) {
      return context.json(jsonRpcError(null, -32001, 'A bearer token is required.'), 401);
    }
    if (!context.req.header('content-type')?.toLowerCase().startsWith('application/json')) {
      return context.json(
        jsonRpcError(null, -32600, 'Content-Type must be application/json.'),
        415,
      );
    }

    let body: unknown;
    try {
      body = await context.req.json();
    } catch {
      return context.json(jsonRpcError(null, -32700, 'Invalid JSON.'), 400);
    }
    const parsed = JsonRpcMessageSchema.safeParse(body);
    if (!parsed.success) {
      return context.json(jsonRpcError(null, -32600, 'Invalid MCP request.'), 400);
    }

    const message = parsed.data;
    if (message.id === undefined) {
      return message.method === 'notifications/initialized'
        ? context.body(null, 202)
        : context.json(
            jsonRpcError(null, -32600, 'Unsupported MCP notification.'),
            400,
          );
    }
    if (message.method === 'server/discover') {
      return context.json(
        jsonRpcError(message.id, -32601, 'Method not found.'),
      );
    }

    const repository = store.as(tokenValue(bearer));
    const initializeParams = message.method === 'initialize'
      ? InitializeParamsSchema.safeParse(message.params)
      : undefined;
    if (initializeParams && !initializeParams.success) {
      return context.json(
        jsonRpcError(message.id, -32602, 'Invalid initialize parameters.'),
        400,
      );
    }
    if (
      initializeParams &&
      !streamableHttpVersions.has(initializeParams.data.protocolVersion)
    ) {
      return context.json(
        jsonRpcError(message.id, -32602, 'Unsupported MCP protocol version.'),
        400,
      );
    }
    try {
      const value = await invokeOne(
        repository,
        context.req.param('connectionId'),
        {
          method: message.method,
          ...(message.params === undefined ? {} : { params: message.params }),
        },
        context.req.raw.signal,
      );
      if (message.method === 'initialize') {
        const description = ProxyDescriptionSchema.parse(value);
        return context.json({
          jsonrpc: '2.0' as const,
          id: message.id,
          result: {
            protocolVersion: initializeParams!.data.protocolVersion,
            capabilities: requestResponseCapabilities(description.capabilities),
            serverInfo: {
              name: 'rgap-mcp-proxy',
              version: '0.0.0',
            },
            ...(description.instructions
              ? { instructions: description.instructions }
              : {}),
          },
        });
      }
      return context.json({
        jsonrpc: '2.0' as const,
        id: message.id,
        result: value,
      });
    } catch (error) {
      const response = invocationError(message.id, error);
      return context.json(response.body, response.status);
    }
  });

  const methodNotAllowed = (context: Context) => {
    context.header('Allow', 'POST');
    return context.body(null, 405);
  };
  app.get('/mcp/:connectionId', methodNotAllowed);
  app.delete('/mcp/:connectionId', methodNotAllowed);

  return app;
}

const ProxyDescriptionSchema = z.object({
  capabilities: z.record(z.string(), z.unknown()),
  serverInfo: z.object({
    name: z.string(),
    version: z.string(),
  }).passthrough(),
  instructions: z.string().optional(),
});

async function invokeOne(
  repository: ReturnType<RgapStore['as']>,
  connectionId: string,
  input: { method: string; params?: unknown },
  signal: AbortSignal,
) {
  let value: unknown;
  let count = 0;
  for await (const event of repository.invoke(resourceId(connectionId), {
    input,
    signal,
  })) {
    if (event.type !== 'data') continue;
    value = event.value;
    count += 1;
  }
  if (count > 1) {
    throw new Error('The MCP runtime returned more than one result.');
  }
  return value ?? null;
}

function bearerToken(authorization?: string) {
  return authorization?.match(/^Bearer (\S+)$/)?.[1];
}

function jsonRpcError(id: JsonRpcId | null, code: number, message: string) {
  return {
    jsonrpc: '2.0' as const,
    id,
    error: { code, message },
  };
}

function invocationError(id: JsonRpcId, error: unknown) {
  if (error instanceof ProtocolError) {
    return {
      status: 200 as const,
      body: {
        ...jsonRpcError(id, error.code, error.message),
        ...(error.data === undefined
          ? {}
          : { error: { code: error.code, message: error.message, data: error.data } }),
      },
    };
  }
  if (error instanceof RgapError) {
    if (error.code === 'invalid_bearer') {
      return {
        status: 401 as const,
        body: jsonRpcError(id, -32001, error.message),
      };
    }
    if (error.code === 'unauthorized') {
      return {
        status: 403 as const,
        body: jsonRpcError(id, -32003, error.message),
      };
    }
    if (error.code.startsWith('missing_')) {
      return {
        status: 404 as const,
        body: jsonRpcError(id, -32004, error.message),
      };
    }
  }
  console.error('MCP proxy invocation failed.');
  return {
    status: 500 as const,
    body: jsonRpcError(id, -32603, 'MCP invocation failed.'),
  };
}

function requestResponseCapabilities(
  capabilities: Record<string, unknown>,
) {
  return Object.fromEntries(
    ['tools', 'prompts', 'resources', 'completions']
      .filter((capability) => capabilities[capability] !== undefined)
      .map((capability) => [capability, {}]),
  );
}
