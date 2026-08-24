import { timingSafeEqual } from 'node:crypto';
import { swaggerUI } from '@hono/swagger-ui';
import { createRoute, OpenAPIHono, type RouteConfig, z } from '@hono/zod-openapi';
import {
  grantId,
  resourceId,
  RgapError,
  tokenId,
  tokenValue,
  type GrantBinding,
  type GrantHandle,
  type InvocationEvent,
  type JsonValue,
  type ResourceHandle,
  type RgapRepository,
  type RgapStore,
  type TokenHandle,
} from '@rgap/core';
import {
  AuditEventSchema,
  AuthorizationHeaderSchema,
  AuthorizeSchema,
  ExecutableDefinitionSchema,
  InvocationEventSchema,
  InvokeSchema,
  DecisionSchema,
  ErrorSchema,
  GrantListQuerySchema,
  GrantSchema,
  GrantWriteSchema,
  IdParamsSchema,
  IssuedTokenSchema,
  MoveResourceSchema,
  PageQuerySchema,
  SetExecutableSchema,
  ResourceListQuerySchema,
  ResourceSchema,
  ResourceWriteSchema,
  SetBindingsSchema,
  TokenListQuerySchema,
  TokenSchema,
  TokenWriteSchema,
} from './schemas';

type Env = {
  Variables: {
    repository: RgapRepository;
    admin: boolean;
  };
};

export type AppOptions = {
  store: RgapStore;
  adminToken?: string;
};

const bearerSecurity = [{ bearerAuth: [] }];
const errors = {
  400: jsonResponse(ErrorSchema, 'Invalid request'),
  401: jsonResponse(ErrorSchema, 'Missing or invalid bearer'),
  403: jsonResponse(ErrorSchema, 'Operation is not authorized'),
  404: jsonResponse(ErrorSchema, 'Record does not exist'),
  409: jsonResponse(ErrorSchema, 'RGAP domain conflict'),
  500: jsonResponse(ErrorSchema, 'Internal server error'),
} as const;

const getResourceRoute = commandRoute({
  method: 'get',
  path: '/resources/{id}',
  operationId: 'getResource',
  request: { params: IdParamsSchema },
  responses: { 200: jsonResponse(ResourceSchema, 'Resource'), ...errors },
});
const listResourcesRoute = commandRoute({
  method: 'get',
  path: '/resources',
  operationId: 'listResources',
  request: { query: ResourceListQuerySchema },
  responses: { 200: jsonResponse(z.array(ResourceSchema), 'Resources'), ...errors },
});
const createResourceRoute = commandRoute({
  method: 'post',
  path: '/resources',
  operationId: 'createResource',
  request: { body: jsonBody(ResourceWriteSchema) },
  responses: { 200: jsonResponse(ResourceSchema, 'Created resource'), ...errors },
});
const moveResourceRoute = commandRoute({
  method: 'post',
  path: '/resources/{id}/move',
  operationId: 'moveResource',
  request: { params: IdParamsSchema, body: jsonBody(MoveResourceSchema) },
  responses: { 200: jsonResponse(ResourceSchema, 'Moved resource'), ...errors },
});
const deleteResourceRoute = commandRoute({
  method: 'delete',
  path: '/resources/{id}',
  operationId: 'deleteResource',
  request: { params: IdParamsSchema },
  responses: { 204: { description: 'Resource deleted' }, ...errors },
});
const getExecutableRoute = commandRoute({
  method: 'get',
  path: '/resources/{id}/executable',
  operationId: 'getExecutable',
  request: { params: IdParamsSchema },
  responses: { 200: jsonResponse(ExecutableDefinitionSchema, 'Executable definition'), ...errors },
});
const setExecutableRoute = commandRoute({
  method: 'put',
  path: '/resources/{id}/executable',
  operationId: 'setExecutable',
  request: { params: IdParamsSchema, body: jsonBody(SetExecutableSchema) },
  responses: { 200: jsonResponse(ExecutableDefinitionSchema, 'Executable definition'), ...errors },
});
const deleteExecutableRoute = commandRoute({
  method: 'delete',
  path: '/resources/{id}/executable',
  operationId: 'deleteExecutable',
  request: { params: IdParamsSchema },
  responses: { 204: { description: 'Executable deleted' }, ...errors },
});
const invokeRoute = commandRoute({
  method: 'post',
  path: '/resources/{id}/invoke',
  operationId: 'invoke',
  request: { params: IdParamsSchema, body: jsonBody(InvokeSchema) },
  responses: {
    200: ndjsonResponse(InvocationEventSchema, 'Invocation event stream'),
    ...errors,
  },
});
const getGrantRoute = commandRoute({
  method: 'get',
  path: '/grants/{id}',
  operationId: 'getGrant',
  request: { params: IdParamsSchema },
  responses: { 200: jsonResponse(GrantSchema, 'Grant'), ...errors },
});
const listGrantsRoute = commandRoute({
  method: 'get',
  path: '/grants',
  operationId: 'listGrants',
  request: { query: GrantListQuerySchema },
  responses: { 200: jsonResponse(z.array(GrantSchema), 'Grants'), ...errors },
});
const createGrantRoute = commandRoute({
  method: 'post',
  path: '/grants',
  operationId: 'createGrant',
  request: { body: jsonBody(GrantWriteSchema) },
  responses: { 200: jsonResponse(GrantSchema, 'Created grant'), ...errors },
});
const setBindingsRoute = commandRoute({
  method: 'put',
  path: '/grants/{id}/bindings',
  operationId: 'setBindings',
  request: { params: IdParamsSchema, body: jsonBody(SetBindingsSchema) },
  responses: { 200: jsonResponse(GrantSchema, 'Updated grant'), ...errors },
});
const issueTokenRoute = commandRoute({
  method: 'post',
  path: '/grants/{id}/tokens',
  operationId: 'issueToken',
  request: { params: IdParamsSchema, body: jsonBody(TokenWriteSchema) },
  responses: { 200: jsonResponse(IssuedTokenSchema, 'Issued token and one-time bearer'), ...errors },
});
const revokeGrantRoute = commandRoute({
  method: 'post',
  path: '/grants/{id}/revoke',
  operationId: 'revokeGrant',
  request: { params: IdParamsSchema },
  responses: { 204: { description: 'Grant revoked' }, ...errors },
});
const getTokenRoute = commandRoute({
  method: 'get',
  path: '/tokens/{id}',
  operationId: 'getToken',
  request: { params: IdParamsSchema },
  responses: { 200: jsonResponse(TokenSchema, 'Token'), ...errors },
});
const listTokensRoute = commandRoute({
  method: 'get',
  path: '/tokens',
  operationId: 'listTokens',
  request: { query: TokenListQuerySchema },
  responses: { 200: jsonResponse(z.array(TokenSchema), 'Tokens'), ...errors },
});
const revokeTokenRoute = commandRoute({
  method: 'post',
  path: '/tokens/{id}/revoke',
  operationId: 'revokeToken',
  request: { params: IdParamsSchema },
  responses: { 204: { description: 'Token revoked' }, ...errors },
});
const listAuditRoute = commandRoute({
  method: 'get',
  path: '/audit',
  operationId: 'listAudit',
  request: { query: PageQuerySchema },
  responses: { 200: jsonResponse(z.array(AuditEventSchema), 'Audit events'), ...errors },
});
const authorizeRoute = commandRoute({
  method: 'post',
  path: '/authorize',
  operationId: 'authorize',
  request: { body: jsonBody(AuthorizeSchema) },
  responses: { 200: jsonResponse(DecisionSchema, 'Authorization decision'), ...errors },
});
const resetRoute = commandRoute({
  method: 'post',
  path: '/reset',
  operationId: 'reset',
  responses: { 204: { description: 'Store reset' }, ...errors },
});

export function createApp({ store, adminToken = 'test' }: AppOptions) {
  const base = new OpenAPIHono<Env>({
    defaultHook(result, c) {
      if (result.success) return;
      return c.json({
        error: {
          code: 'validation_error',
          message: z.prettifyError(result.error),
        },
      }, 400);
    },
  });

  base.use('*', async (c, next) => {
    if (c.req.path === '/openapi.json' || c.req.path === '/ui') return next();
    const authorization = c.req.header('authorization');
    const bearer = authorization?.match(/^Bearer (\S+)$/)?.[1];
    if (!bearer) return apiError(c, 401, 'unauthorized', 'A bearer token is required.');

    const admin = adminToken !== undefined && secretsEqual(bearer, adminToken);
    const repository = admin ? store.admin() : store.as(tokenValue(bearer));
    c.set('repository', repository);
    c.set('admin', admin);
    await next();
  });

  base.onError((error, c) => {
    if (error instanceof RgapError) {
      if (error.code === 'invalid_bearer') {
        return apiError(c, 401, 'unauthorized', error.message);
      }
      const status = error.code === 'unauthorized'
        ? 403
        : error.code.startsWith('missing_') ? 404 : 409;
      return apiError(c, status, error.code, error.message);
    }
    console.error('Unhandled RGAP server error.');
    return apiError(c, 500, 'internal_error', 'Internal server error.');
  });

  // @ts-expect-error Hono's fluent route type exceeds TypeScript's instantiation depth.
  const app = base
    .openapi(getResourceRoute, async (c) => {
      const { id } = c.req.valid('param');
      return c.json(resourceRecord(await repository(c).resources.get(resourceId(id))), 200);
    })
    .openapi(listResourcesRoute, async (c) => {
      const query = c.req.valid('query');
      const records = await repository(c).resources.list({
        ...query,
        parentId: query.parentId === null ? null : resourceId(query.parentId),
        cursor: query.cursor ? resourceId(query.cursor) : undefined,
      });
      return c.json(records, 200);
    })
    .openapi(createResourceRoute, async (c) => {
      const { name, executable } = c.req.valid('json');
      const record = await repository(c).resources.create({
        name,
        executable: executable
          ? {
            ...executable,
            input: executableInput(executable.input),
            bind: executable.bind
              ? Object.fromEntries(
                Object.entries(executable.bind)
                  .map(([binding, boundId]) => [binding, resourceId(boundId)]),
              )
              : undefined,
          }
          : undefined,
      });
      return c.json(resourceRecord(record), 200);
    })
    .openapi(moveResourceRoute, async (c) => {
      const { id } = c.req.valid('param');
      const { parentId } = c.req.valid('json');
      const moved = await repository(c).resources.get(resourceId(id))
        .then((record) => record.move(parentId === null ? null : resourceId(parentId)));
      return c.json(resourceRecord(moved), 200);
    })
    .openapi(deleteResourceRoute, async (c) => {
      const { id } = c.req.valid('param');
      await repository(c).resources.get(resourceId(id)).then((record) => record.delete());
      return c.body(null, 204);
    })
    .openapi(getExecutableRoute, async (c) => {
      const { id } = c.req.valid('param');
      const definition = await repository(c).executables.get(resourceId(id));
      return c.json(requireRecord(definition, 'missing_executable', 'Executable does not exist.'), 200);
    })
    .openapi(setExecutableRoute, async (c) => {
      const { id } = c.req.valid('param');
      const { runtime, input, bind } = c.req.valid('json');
      return c.json(await repository(c).executables.set(resourceId(id), {
        runtime,
        input: executableInput(input),
        bind: bind
          ? Object.fromEntries(
            Object.entries(bind).map(([name, boundId]) => [name, resourceId(boundId)]),
          )
          : undefined,
      }), 200);
    })
    .openapi(deleteExecutableRoute, async (c) => {
      const { id } = c.req.valid('param');
      await repository(c).executables.delete(resourceId(id));
      return c.body(null, 204);
    })
    .openapi(invokeRoute, async (c) => {
      const { id } = c.req.valid('param');
      const { input } = c.req.valid('json');
      // @hono/zod-openapi does not express a typed streaming body, although the route schema
      // documents each NDJSON event. Runtime validation and integration tests cover the stream.
      return invocationResponse(c.req.raw.signal, (signal) => repository(c).invoke(resourceId(id), {
        input,
        signal,
      })) as never;
    })
    .openapi(getGrantRoute, async (c) => {
      const { id } = c.req.valid('param');
      return c.json(grantRecord(await repository(c).grants.get(grantId(id))), 200);
    })
    .openapi(listGrantsRoute, async (c) => {
      const query = c.req.valid('query');
      const records = await repository(c).grants.list({
        ...query,
        parentId: query.parentId === undefined ? undefined : query.parentId === null ? null : grantId(query.parentId),
        cursor: query.cursor ? grantId(query.cursor) : undefined,
      });
      return c.json(records, 200);
    })
    .openapi(createGrantRoute, async (c) => {
      const { bindings, ...input } = c.req.valid('json');
      const write = { ...input, bindings: brandedBindings(bindings) };
      const record = await repository(c).grants.create(write);
      return c.json(grantRecord(record), 200);
    })
    .openapi(setBindingsRoute, async (c) => {
      const { id } = c.req.valid('param');
      const { bindings } = c.req.valid('json');
      const record = await repository(c).grants.get(grantId(id))
        .then((grant) => grant.bindings.set(brandedBindings(bindings)));
      return c.json(grantRecord(record), 200);
    })
    .openapi(issueTokenRoute, async (c) => {
      const { id } = c.req.valid('param');
      const { label } = c.req.valid('json');
      const issued = await repository(c).grants.get(grantId(id))
        .then((grant) => grant.tokens.create({ label }));
      const { value, ...record } = issued;
      return c.json({ record: tokenRecord(record), value }, 200);
    })
    .openapi(revokeGrantRoute, async (c) => {
      const { id } = c.req.valid('param');
      await repository(c).grants.get(grantId(id)).then((grant) => grant.revoke());
      return c.body(null, 204);
    })
    .openapi(getTokenRoute, async (c) => {
      const { id } = c.req.valid('param');
      return c.json(tokenRecord(await repository(c).tokens.get(tokenId(id))), 200);
    })
    .openapi(listTokensRoute, async (c) => {
      const query = c.req.valid('query');
      const records = await repository(c).tokens.list({
        ...query,
        grantId: query.grantId ? grantId(query.grantId) : undefined,
        cursor: query.cursor ? tokenId(query.cursor) : undefined,
      });
      return c.json(records, 200);
    })
    .openapi(revokeTokenRoute, async (c) => {
      const { id } = c.req.valid('param');
      await repository(c).tokens.get(tokenId(id)).then((token) => token.revoke());
      return c.body(null, 204);
    })
    .openapi(listAuditRoute, async (c) => {
      const query = c.req.valid('query');
      return c.json(await repository(c).audit.list(query), 200);
    })
    .openapi(authorizeRoute, async (c) => {
      const { token, resourceId: id, permission } = c.req.valid('json');
      return c.json(await repository(c).authorize(tokenValue(token), resourceId(id), permission), 200);
    })
    .openapi(resetRoute, async (c) => {
      await repository(c).reset();
      return c.body(null, 204);
    });

  app.doc31('/openapi.json', {
    openapi: '3.1.0',
    info: {
      title: 'RGAP API',
      version: '0.0.0',
    },
    security: bearerSecurity,
  });
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
  });
  app.get('/ui', swaggerUI({ url: '/openapi.json' }));

  return app;
}

export type AppType = ReturnType<typeof createApp>;

function commandRoute<const T extends RouteConfig>(route: T): T {
  return createRoute({
    ...route,
    security: bearerSecurity,
    request: {
      headers: AuthorizationHeaderSchema,
      ...route.request,
    },
  }) as T;
}

function jsonBody<T extends z.ZodType>(schema: T) {
  return {
    required: true,
    content: {
      'application/json': { schema },
    },
  };
}

function jsonResponse<T extends z.ZodType>(schema: T, description: string) {
  return {
    description,
    content: {
      'application/json': { schema },
    },
  };
}

function ndjsonResponse<T extends z.ZodType>(schema: T, description: string) {
  return {
    description,
    content: {
      'application/x-ndjson': { schema },
    },
  };
}

function repository(c: { get(name: 'repository'): RgapRepository }) {
  return c.get('repository');
}

async function invocationResponse(
  requestSignal: AbortSignal,
  invoke: (signal: AbortSignal) => AsyncIterable<InvocationEvent>,
) {
  const controller = new AbortController();
  const cancel = () => controller.abort(requestSignal.reason);
  if (requestSignal.aborted) cancel();
  else requestSignal.addEventListener('abort', cancel, { once: true });

  const iterator = invoke(controller.signal)[Symbol.asyncIterator]();
  let next: IteratorResult<InvocationEvent>;
  try {
    next = await iterator.next();
  } catch (error) {
    requestSignal.removeEventListener('abort', cancel);
    controller.abort(error);
    throw error;
  }

  const encoder = new TextEncoder();
  let first: IteratorResult<InvocationEvent> | undefined = next;
  const close = () => {
    requestSignal.removeEventListener('abort', cancel);
    controller.abort();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(stream) {
      try {
        const result = first ?? await iterator.next();
        first = undefined;
        if (result.done) {
          stream.close();
          close();
          return;
        }
        if (result.value.type === 'data' && result.value.value === undefined) {
          throw new RgapError('invalid_runtime_event', 'Runtime data events require a JSON-compatible value.');
        }
        const encoded = JSON.stringify(result.value);
        if (encoded === undefined) {
          throw new RgapError('invalid_runtime_event', 'Runtime events must be JSON-compatible.');
        }
        stream.enqueue(encoder.encode(`${encoded}\n`));
      } catch (error) {
        try {
          await iterator.return?.();
        } catch {
          // Preserve the stream failure that required iterator cleanup.
        }
        stream.error(error);
        close();
      }
    },
    async cancel(reason) {
      controller.abort(reason);
      requestSignal.removeEventListener('abort', cancel);
      await iterator.return?.();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  });
}

function requireRecord<T>(record: T | undefined, code: string, message: string): T {
  if (record === undefined) throw new RgapError(code, message);
  return record;
}

function resourceRecord(record: ResourceHandle) {
  const { id, parentId, name, deletedAt } = record;
  return { id, parentId, name, deletedAt };
}

function grantRecord(record: GrantHandle) {
  const { id, name, parentId, bindings, expiresAt, revokedAt } = record;
  return { id, name, parentId, bindings: [...bindings], expiresAt, revokedAt };
}

function tokenRecord(record: TokenHandle) {
  const { id, grantId: owningGrantId, label, hash, expiresAt, revokedAt } = record;
  return { id, grantId: owningGrantId, label, hash, expiresAt, revokedAt };
}

function brandedBindings(
  bindings: Array<{ permissions: GrantBinding['permissions']; id: string }>,
): GrantBinding[] {
  return bindings.map((binding) => ({ ...binding, id: resourceId(binding.id) }));
}

function executableInput(input: Record<string, unknown> | undefined) {
  return input as Record<string, JsonValue> | undefined;
}

function secretsEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function apiError(
  c: { json(value: { error: { code: string; message: string } }, status: 400 | 401 | 403 | 404 | 409 | 500): Response },
  status: 400 | 401 | 403 | 404 | 409 | 500,
  code: string,
  message: string,
) {
  return c.json({ error: { code, message } }, status);
}
