# OpenAI-compatible RGAP gateway

This Hono server proxies every `/v1/*` request to the matching OpenAI endpoint while using the incoming bearer as an RGAP employee credential.

## Bootstrap

```bash
export RGAP_DATABASE_URL=llm-gateway.db
pnpm --filter @rgap/llm-gateway-example bootstrap
```

The command prints the stable OpenAI resource ID:

```text
OPENAI_RESOURCE_ID=...
```

## Run

```bash
export RGAP_DATABASE_URL=llm-gateway.db
export OPENAI_RESOURCE_ID=...
export OPENAI_API_KEY=sk-...
export PORT=8787
pnpm --filter @rgap/llm-gateway-example start
```

## Client

In another process, run the official OpenAI SDK walkthrough against the same store and gateway:

```bash
export RGAP_DATABASE_URL=llm-gateway.db
export OPENAI_RESOURCE_ID=...
export EMPLOYEE_NAME=alice
export OPENAI_BASE_URL=http://localhost:8787/v1
pnpm --filter @rgap/llm-gateway-example client
```

The client creates Alice's RGAP grant, issues a bearer, supplies that bearer to the OpenAI SDK, and calls `responses.create`.

The employee bearer never reaches OpenAI. The gateway authorizes `invoke` on the configured resource, replaces the authorization header, removes `Host`, and returns the upstream response directly.

The app factory accepts a custom upstream origin and fetch implementation for tests or an OpenAI-compatible private endpoint. Production deployments keep the origin fixed in trusted configuration.
