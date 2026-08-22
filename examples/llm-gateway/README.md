# OpenAI-compatible RGAP gateway

This Hono server proxies every `/v1/*` request to the matching OpenAI endpoint while using the incoming bearer as an RGAP employee credential.

## Bootstrap

```bash
export RGAP_DATABASE_URL=llm-gateway.db
export EMPLOYEE_NAME=alice
pnpm --filter @rgap/llm-gateway-example bootstrap
```

The command prints the stable OpenAI resource ID and a one-time employee bearer:

```text
OPENAI_RESOURCE_ID=...
OPENAI_GATEWAY_TOKEN=rgap_...
```

## Run

```bash
export RGAP_DATABASE_URL=llm-gateway.db
export OPENAI_RESOURCE_ID=...
export OPENAI_API_KEY=sk-...
export PORT=8787
pnpm --filter @rgap/llm-gateway-example start
```

Configure an OpenAI-compatible client:

```bash
export OPENAI_BASE_URL=http://localhost:8787/v1
export OPENAI_API_KEY="$OPENAI_GATEWAY_TOKEN"
```

The employee bearer never reaches OpenAI. The gateway authorizes `invoke` on the configured resource, replaces the authorization header, removes `Host`, and returns the upstream response directly.

The app factory accepts a custom upstream origin and fetch implementation for tests or an OpenAI-compatible private endpoint. Production deployments keep the origin fixed in trusted configuration.
