/** Permissions understood by the reference RGAP contract. */
export const permissions = ['read', 'write', 'invoke', 'move', 'delete'] as const;
export type Permission = (typeof permissions)[number];

declare const identityBrand: unique symbol;
type Identity<Kind extends string> = string & { readonly [identityBrand]: Kind };

/** A resource's stable identity. Not a grant, token, or bearer value. */
export type ResourceId = Identity<'ResourceId'>;
/** A grant's stable identity. A grant's parent is always a grant. */
export type GrantId = Identity<'GrantId'>;
/** A token record's stable identity. Not the bearer secret. */
export type TokenId = Identity<'TokenId'>;
/** The bearer secret returned once at issue. `store.as`, `authorize`, and `inspectToken` take this. */
export type TokenValue = Identity<'TokenValue'>;
/** The stored hash of a bearer secret. The bearer itself is never stored. */
export type TokenHash = Identity<'TokenHash'>;
/** The record an audit event concerns. */
export type RecordId = ResourceId | GrantId | TokenId;

export const resourceId = (id: string): ResourceId => id as ResourceId;
export const grantId = (id: string): GrantId => id as GrantId;
export const tokenId = (id: string): TokenId => id as TokenId;
export const tokenValue = (id: string): TokenValue => id as TokenValue;
export const tokenHash = (id: string): TokenHash => id as TokenHash;
export type BindingSlot = {
  kind: string;
  required?: boolean;
};

export type ExecutableDefinition = {
  resourceId: ResourceId;
  runtime: string;
};

export type Resource = {
  id: ResourceId;
  parentId: ResourceId | null;
  name: string;
  /** Set when the resource is deleted. The record is retained so its stable ID is never reissued. */
  deletedAt: string | null;
};

export type CapabilityConfig = {
  permissions: Permission[];
};

export type ResourceCapability = CapabilityConfig & { resourceId: ResourceId };
export type PathCapability = CapabilityConfig & { path: string };
export type Capability = ResourceCapability | PathCapability;

export function isPathCapability(capability: Capability): capability is PathCapability {
  return 'path' in capability;
}

export type Grant = {
  id: GrantId;
  name: string;
  parentId: GrantId | null;
  capabilities: Capability[];
  expiresAt: string | null;
  revokedAt: string | null;
};

export type Token = {
  id: TokenId;
  grantId: GrantId;
  label: string;
  hash: TokenHash;
  expiresAt: string | null;
  revokedAt: string | null;
};

export type AuditEvent = {
  id: string;
  at: string;
  action: string;
  target: RecordId;
  result: 'allowed' | 'denied' | 'recorded';
  detail: string;
};

export type State = {
  resources: Record<string, Resource>;
  grants: Record<string, Grant>;
  tokens: Record<string, Token>;
  executables: Record<string, ExecutableDefinition>;
  audit: AuditEvent[];
};

export type Decision = {
  allowed: boolean;
  detail: string;
  grantId: GrantId | null;
  lineage: GrantId[];
};

export type CreateGrantInput = Omit<Grant, 'id' | 'revokedAt'>;
export type CreateResourceInput = Omit<Resource, 'id' | 'deletedAt'>;
export type AuthorityView = {
  valid: boolean;
  detail: string;
  grantId: GrantId | null;
  lineage: GrantId[];
  permissions: Record<string, Permission[]>;
};

export class RgapError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Thrown when creating or amending a grant whose parent is missing, revoked, or expired. */
export class InvalidParentError extends RgapError {
  constructor(code: 'missing_parent' | 'inactive_parent', message: string) {
    super(code, message);
  }
}

const copy = (state: State): State => structuredClone(state);
/** A deleted resource is retained only as a tombstone; nothing but its ID and path history remains observable. */
export const isLive = (resource: Resource | undefined): resource is Resource => Boolean(resource && !resource.deletedAt);
export type ResourceCollection = State['resources'] | readonly Resource[];
const resourceRecords = (resources: ResourceCollection) =>
  Array.isArray(resources) ? resources : Object.values(resources);
const resourceRecord = (resources: ResourceCollection, id: ResourceId) =>
  Array.isArray(resources)
    ? resources.find((resource) => resource.id === id)
    : (resources as State['resources'])[id];
export const liveResources = (resources: ResourceCollection) => resourceRecords(resources).filter(isLive);
const active = (item: { revokedAt: string | null; expiresAt: string | null }, now: string) =>
  !item.revokedAt && (!item.expiresAt || item.expiresAt > now);

export function isWithin(resources: ResourceCollection, id: ResourceId, rootId: ResourceId) {
  const seen = new Set<string>();
  for (let current: ResourceId | null = id; current; current = resourceRecord(resources, current)?.parentId ?? null) {
    if (current === rootId) return true;
    if (seen.has(current)) throw new RgapError('resource_cycle', 'Resource tree contains a cycle.');
    seen.add(current);
  }
  return false;
}

export function resourcePath(resources: ResourceCollection, id: ResourceId) {
  const names: string[] = [];
  const seen = new Set<string>();
  for (let current: ResourceId | null = id; current; current = resourceRecord(resources, current)?.parentId ?? null) {
    if (seen.has(current)) throw new RgapError('resource_cycle', 'Resource tree contains a cycle.');
    const resource = resourceRecord(resources, current);
    if (!resource) throw new RgapError('missing_resource', `Resource ${current} does not exist.`);
    names.unshift(resource.name);
    seen.add(current);
  }
  return names.join('/');
}

/**
 * The path of a resource whose record may be absent. A correct state retains every record so that
 * every referenced ID resolves, so this returns null only for a state that broke that rule.
 */
export function tryResourcePath(resources: ResourceCollection, id: ResourceId) {
  try {
    return resourcePath(resources, id);
  } catch {
    return null;
  }
}

/**
 * The referential integrity a state must have for its records to be readable: every ID a grant,
 * token, or resource refers to resolves to a record. Returns one message per broken reference.
 */
export function stateIntegrity(state: State) {
  const problems: string[] = [];
  Object.values(state.resources).forEach((resource) => {
    if (resource.parentId && !state.resources[resource.parentId]) {
      problems.push(`Resource ${resource.id} refers to missing parent ${resource.parentId}.`);
    }
  });
  Object.values(state.grants).forEach((grant) => {
    if (grant.parentId && !state.grants[grant.parentId]) {
      problems.push(`Grant ${grant.id} refers to missing parent ${grant.parentId}.`);
    }
    grant.capabilities.forEach((cap) => {
      if (!isPathCapability(cap) && !state.resources[cap.resourceId]) {
        problems.push(`Grant ${grant.id} refers to missing resource ${cap.resourceId}.`);
      }
    });
  });
  Object.values(state.tokens).forEach((token) => {
    if (!state.grants[token.grantId]) problems.push(`Token ${token.id} refers to missing grant ${token.grantId}.`);
  });
  Object.values(state.executables).forEach((definition) => {
    if (!state.resources[definition.resourceId]) {
      problems.push(`Executable ${definition.resourceId} refers to a missing resource.`);
    }
  });
  return problems;
}

/** Resolves a path to a stable resource ID. The root is not a resource, so an empty path resolves to null. */
export function resourceIdAtPath(resources: ResourceCollection, path: string) {
  let parentId: ResourceId | null = null;
  for (const name of pathParts(path)) {
    const match = liveResources(resources).find((item) => item.parentId === parentId && item.name === name);
    if (!match) return null;
    parentId = match.id;
  }
  return parentId;
}

/** Resolves a path that must name an existing resource, such as the target of a move or delete. */
export function requireResourceId(resources: ResourceCollection, path: string) {
  const id = resourceIdAtPath(resources, path);
  if (!id) throw new RgapError('missing_resource', `No resource exists at ${normalizePath(path) || '/'}.`);
  return id;
}

export const normalizePath = (path: string) => pathParts(path).join('/');

function targetResourceId(capability: Capability, resources: State['resources']) {
  if (isPathCapability(capability)) return resourceIdAtPath(resources, capability.path);
  return isLive(resources[capability.resourceId]) ? capability.resourceId : null;
}

/** Whether one entry authorizes a request against the current live resource tree. */
export function capabilityAuthorizes(
  capability: Capability,
  resources: State['resources'],
  id: ResourceId,
  permission: Permission,
) {
  if (!capability.permissions.includes(permission)) return false;
  const rootId = targetResourceId(capability, resources);
  return Boolean(rootId && isWithin(resources, id, rootId));
}

function pathContains(parent: Capability, child: Capability) {
  if (!isPathCapability(parent) || !isPathCapability(child)) return null;
  const parentParts = pathParts(normalizePath(parent.path));
  const childParts = pathParts(normalizePath(child.path));
  return parentParts.every((part, index) => childParts[index] === part);
}

/** Whether every request the child entry currently authorizes is also authorized by the parent. */
export function covers(parent: Capability, child: Capability, resources: State['resources']) {
  const lexicalCoverage = pathContains(parent, child);
  const parentId = targetResourceId(parent, resources);
  const childId = targetResourceId(child, resources);
  const locationCovered = lexicalCoverage ?? Boolean(parentId && childId && isWithin(resources, childId, parentId));
  return locationCovered && child.permissions.every((permission) => parent.permissions.includes(permission));
}

function normalizeCapabilities(capabilities: Capability[], resources: State['resources']) {
  return capabilities.map((capability) => {
    if (!capability.permissions.length) throw new RgapError('invalid_capability', 'Select at least one permission.');
    if (isPathCapability(capability)) {
      if ('resourceId' in capability) {
        throw new RgapError('invalid_capability', 'Capability must name a resourceId or a path.');
      }
      const path = normalizePath(capability.path);
      if (!path) throw new RgapError('invalid_capability', 'Capability path is required.');
      return { ...structuredClone(capability), path };
    }
    if (!('resourceId' in capability)) {
      throw new RgapError('invalid_capability', 'Capability must name a resourceId or a path.');
    }
    if (!isLive(resources[capability.resourceId])) {
      throw new RgapError('missing_resource', 'Capability resource does not exist.');
    }
    return structuredClone(capability);
  });
}

function requireActiveParent(state: State, parentId: GrantId, at: string) {
  const parent = state.grants[parentId];
  if (!parent) throw new InvalidParentError('missing_parent', 'Parent grant does not exist.');
  if (!active(parent, at)) throw new InvalidParentError('inactive_parent', 'Parent grant is revoked or expired.');
  return parent;
}

function lineage(state: State, id: GrantId) {
  const result: Grant[] = [];
  const seen = new Set<string>();
  for (let current: GrantId | null = id; current; current = state.grants[current]?.parentId ?? null) {
    if (seen.has(current)) throw new RgapError('grant_cycle', 'Grant tree contains a cycle.');
    const grant = state.grants[current];
    if (!grant) throw new RgapError('missing_parent', `Grant ${current} does not exist.`);
    seen.add(current);
    result.push(grant);
  }
  return result;
}

function audit(state: State, event: Omit<AuditEvent, 'id'>) {
  state.audit.unshift({ id: `${event.at}:${event.action}:${state.audit.length}`, ...event });
}

function revokeBranch(state: State, id: GrantId, at: string) {
  const ids = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    Object.values(state.grants).forEach((grant) => {
      if (grant.parentId && ids.has(grant.parentId) && !ids.has(grant.id)) {
        ids.add(grant.id);
        changed = true;
      }
    });
  }
  ids.forEach((id) => { state.grants[id].revokedAt ||= at; });
}

export function createResource(
  state: State,
  input: CreateResourceInput,
  id: ResourceId,
  at: string,
) {
  if (!input.name.trim()) throw new RgapError('invalid_name', 'Resource name is required.');
  if (input.name.includes('/')) throw new RgapError('invalid_name', 'Resource names cannot contain slashes.');
  if (state.resources[id]) throw new RgapError('duplicate_id', `Resource ${id} already exists.`);
  if (input.parentId && !isLive(state.resources[input.parentId])) throw new RgapError('missing_parent', 'Parent resource does not exist.');
  if (liveResources(state.resources).some((item) => item.parentId === input.parentId && item.name === input.name.trim())) {
    throw new RgapError('duplicate_path', 'A resource already exists at that path.');
  }
  const next = copy(state);
  next.resources[id] = { ...input, id, name: input.name.trim(), deletedAt: null };
  audit(next, { at, action: 'resource.create', target: id, result: 'recorded', detail: `Created ${input.name}.` });
  return next;
}

export function moveResource(state: State, id: ResourceId, parentId: ResourceId | null, at: string) {
  const resource = state.resources[id];
  if (!isLive(resource)) throw new RgapError('missing_resource', 'Resource does not exist.');
  if (parentId && !isLive(state.resources[parentId])) throw new RgapError('missing_parent', 'Parent resource does not exist.');
  if (parentId === id || (parentId && isWithin(state.resources, parentId, id))) {
    throw new RgapError('resource_cycle', 'A resource cannot move inside itself.');
  }
  const next = copy(state);
  next.resources[id].parentId = parentId;
  audit(next, { at, action: 'resource.move', target: id, result: 'recorded', detail: `Moved ${resource.name}.` });
  return next;
}

export function deleteResource(state: State, id: ResourceId, at: string) {
  const resource = state.resources[id];
  if (!isLive(resource)) throw new RgapError('missing_resource', 'Resource does not exist.');
  const removed = liveResources(state.resources)
    .filter((candidate) => isWithin(state.resources, candidate.id, id))
    .map((candidate) => candidate.id);
  const next = copy(state);
  removed.forEach((removedId) => { next.resources[removedId].deletedAt = at; });
  audit(next, { at, action: 'resource.delete', target: id, result: 'recorded', detail: `Deleted ${resource.name} and its descendants.` });
  return next;
}

export function createGrant(state: State, input: CreateGrantInput, id: GrantId, at: string) {
  if (!input.name.trim()) throw new RgapError('invalid_grant', 'Grant name is required.');
  const capabilities = normalizeCapabilities(input.capabilities, state.resources);
  if (input.parentId) {
    const parent = requireActiveParent(state, input.parentId, at);
    if (parent.expiresAt && (!input.expiresAt || input.expiresAt > parent.expiresAt)) {
      throw new RgapError('expiration_expands', 'Child expiration must not exceed its parent.');
    }
    capabilities.forEach((cap) => {
      if (!parent.capabilities.some((parentCap) => covers(parentCap, cap, state.resources))) {
        throw new RgapError('authority_expands', 'Child capability is not covered by its parent.');
      }
    });
  }
  const next = copy(state);
  next.grants[id] = {
    ...input, capabilities, id, name: input.name.trim(), revokedAt: null,
  };
  audit(next, { at, action: input.parentId ? 'grant.delegate' : 'grant.create', target: id, result: 'recorded', detail: `Created ${input.name}.` });
  return next;
}

/**
 * Replaces a grant's whole capability set in one transition. Identity, parent, and expiry
 * are fixed at issue; what a grant reaches is not, so this runs the same downscoping proof as issue
 * at the moment the set changes, and revokes any child the new set no longer covers.
 */
export function setCapabilities(state: State, grantId: GrantId, capabilities: Capability[], at: string) {
  const grant = state.grants[grantId];
  if (!grant) throw new RgapError('missing_grant', 'Grant does not exist.');
  if (!active(grant, at)) throw new RgapError('inactive_grant', 'A revoked or expired grant is not amended.');
  const normalized = normalizeCapabilities(capabilities, state.resources);
  if (grant.parentId) {
    const parent = requireActiveParent(state, grant.parentId, at);
    normalized.forEach((cap) => {
      if (!parent.capabilities.some((parentCap) => covers(parentCap, cap, state.resources))) {
        throw new RgapError('authority_expands', 'Capability is not covered by the parent grant.');
      }
    });
  }
  const next = copy(state);
  next.grants[grantId] = { ...grant, capabilities: normalized };
  // Only direct children are checked: a deeper grant is covered against its own parent, unchanged here.
  const orphaned = Object.values(state.grants).filter((child) =>
    child.parentId === grantId &&
    active(child, at) &&
    child.capabilities.some((cap) => !normalized.some((kept) => covers(kept, cap, state.resources))),
  );
  orphaned.forEach((child) => revokeBranch(next, child.id, at));
  audit(next, {
    at, action: 'grant.capabilities', target: grantId, result: 'recorded',
    detail: orphaned.length
      ? `Set ${normalized.length} entries on ${grant.name}, revoking ${orphaned.map((child) => child.name).join(', ')}.`
      : `Set ${normalized.length} entries on ${grant.name}.`,
  });
  return next;
}

export function recordToken(state: State, token: Token, at: string) {
  const grant = state.grants[token.grantId];
  if (!grant || !active(grant, at)) throw new RgapError('inactive_grant', 'Grant is missing or inactive.');
  const next = copy(state);
  next.tokens[token.id] = token;
  audit(next, { at, action: 'token.issue', target: token.id, result: 'recorded', detail: `Issued ${token.label}.` });
  return next;
}

export function revokeToken(state: State, id: TokenId, at: string) {
  if (!state.tokens[id]) throw new RgapError('missing_token', 'Token does not exist.');
  const next = copy(state);
  next.tokens[id].revokedAt ||= at;
  audit(next, { at, action: 'token.revoke', target: id, result: 'recorded', detail: `Revoked ${next.tokens[id].label}.` });
  return next;
}

export function revokeGrant(state: State, id: GrantId, at: string) {
  if (!state.grants[id]) throw new RgapError('missing_grant', 'Grant does not exist.');
  const next = copy(state);
  revokeBranch(next, id, at);
  audit(next, { at, action: 'grant.revoke', target: id, result: 'recorded', detail: `Revoked ${state.grants[id].name} and its descendants.` });
  return next;
}

export function authorize(state: State, hash: TokenHash, id: ResourceId, permission: Permission, at: string): Decision {
  if (!isLive(state.resources[id])) return { allowed: false, detail: 'Resource does not exist.', grantId: null, lineage: [] };
  const token = Object.values(state.tokens).find((item) => item.hash === hash);
  if (!token || !active(token, at)) return { allowed: false, detail: 'Token is unknown, expired, or revoked.', grantId: null, lineage: [] };
  const chain = lineage(state, token.grantId);
  if (chain.some((grant) => !active(grant, at))) {
    return { allowed: false, detail: 'A grant in the delegation chain is expired or revoked.', grantId: token.grantId, lineage: chain.map((grant) => grant.id) };
  }
  const allowed = chain.every((grant) =>
    grant.capabilities.some((capability) => capabilityAuthorizes(capability, state.resources, id, permission)),
  );
  return {
    allowed,
    detail: allowed ? `${permission} is covered by every grant in the chain.` : `No ${permission} capability survives the complete grant chain.`,
    grantId: token.grantId,
    lineage: chain.map((grant) => grant.id),
  };
}

export function inspectAuthority(state: State, hash: TokenHash, at: string): AuthorityView {
  const token = Object.values(state.tokens).find((item) => item.hash === hash);
  if (!token || !active(token, at)) {
    return { valid: false, detail: 'Token is unknown, expired, or revoked.', grantId: null, lineage: [], permissions: {} };
  }
  const chain = lineage(state, token.grantId);
  if (chain.some((grant) => !active(grant, at))) {
    return { valid: false, detail: 'A grant in the delegation chain is expired or revoked.', grantId: token.grantId, lineage: chain.map((grant) => grant.id), permissions: {} };
  }
  const effective = Object.fromEntries(liveResources(state.resources).map((resource) => resource.id).flatMap((id) => {
    const allowed = permissions.filter((permission) => authorize(state, hash, id, permission, at).allowed);
    return allowed.length ? [[id, allowed]] : [];
  }));
  return {
    valid: true,
    detail: `${Object.keys(effective).length} resources are visible through ${chain[0].name}.`,
    grantId: token.grantId,
    lineage: chain.map((grant) => grant.id),
    permissions: effective,
  };
}

const pathParts = (path: string) => path.split('/').map((part) => part.trim()).filter(Boolean);

/** Mints a readable, unused stable ID from a resource name. */
export function availableId(state: State, name: string) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'resource';
  let id = resourceId(base);
  let suffix = 2;
  while (state.resources[id]) id = resourceId(`${base}-${suffix++}`);
  return id;
}
