const baseUrl = process.env.RGAP_BASE_URL ?? 'http://localhost:3000';
const adminToken = process.env.RGAP_ADMIN_TOKEN ?? 'test';

type Resource = { id: string };
type Grant = { id: string };
type IssuedToken = { value: string };

async function request<T>(
  path: string,
  method: 'POST' | 'PUT',
  body: unknown,
  bearer = adminToken,
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${bearer}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`RGAP returned ${response.status}.`);
  return response.json() as Promise<T>;
}

const model = await request<Resource>('/resources', 'POST', {
  name: 'acme/models/openai',
});
await request(`/resources/${model.id}/executable`, 'PUT', {
  runtime: 'openai',
});

const agentGrant = await request<Grant>('/grants', 'POST', {
  name: 'company/openai-agent',
  resources: [{ id: model.id, permissions: ['invoke'] }],
  expiresAt: null,
});
const issued = await request<IssuedToken>(
  `/grants/${agentGrant.id}/tokens`,
  'POST',
  { label: 'openai-agent' },
);

const response = await fetch(`${baseUrl}/resources/${model.id}/invoke`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${issued.value}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({
    input: { prompt: 'Summarize why capability attenuation matters.' },
  }),
});
if (!response.ok) throw new Error(`RGAP returned ${response.status}.`);

const events = (await response.text())
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line));

console.log(events);
