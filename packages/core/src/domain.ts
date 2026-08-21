/** Permissions understood by the reference RGAP contract. */
export const permissions = ['read', 'write', 'delete', 'move', 'invoke'] as const;
export type Permission = (typeof permissions)[number];
export type RelocationPolicy = 'follow_resource' | 'revoke_on_scope_exit' | 'deny_move';

export type Resource = {
  id: string;
  parentId: string | null;
  name: string;
  movePolicy: 'normal' | 'deny_while_granted';
  deletePolicy: 'revoke' | 'deny_while_granted';
  /** Set when the resource is deleted. The record is retained so its stable ID is never reissued. */
  deletedAt: string | null;
};

export type Capability = {
  resourceId: string;
  permissions: Permission[];
  descendants: boolean;
  relocation: RelocationPolicy;
};

export type Grant = {
  id: string;
  name: string;
  subject: string;
  parentId: string | null;
  capabilities: Capability[];
  expiresAt: string | null;
  revokedAt: string | null;
};

export type Token = {
  id: string;
  grantId: string;
  label: string;
  hash: string;
  expiresAt: string | null;
  revokedAt: string | null;
};

export type AuditEvent = {
  id: string;
  at: string;
  action: string;
  target: string;
  result: 'allowed' | 'denied' | 'recorded';
  detail: string;
};

export type State = {
  resources: Record<string, Resource>;
  grants: Record<string, Grant>;
  tokens: Record<string, Token>;
  audit: AuditEvent[];
};

export type Decision = {
  allowed: boolean;
  detail: string;
  grantId: string | null;
  lineage: string[];
};

export type CreateGrantInput = Omit<Grant, 'id' | 'revokedAt'>;
export type CreateResourceInput = Omit<Resource, 'id' | 'deletedAt'>;
export type AuthorityView = {
  valid: boolean;
  detail: string;
  grantId: string | null;
  lineage: string[];
  permissions: Record<string, Permission[]>;
};

export class RgapError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

const copy = (state: State): State => structuredClone(state);
/** A deleted resource is retained only as a tombstone; nothing but its ID and path history remains observable. */
export const isLive = (resource: Resource | undefined): resource is Resource => Boolean(resource && !resource.deletedAt);
export const liveResources = (resources: State['resources']) => Object.values(resources).filter(isLive);
const active = (item: { revokedAt: string | null; expiresAt: string | null }, now: string) =>
  !item.revokedAt && (!item.expiresAt || item.expiresAt > now);

export function isWithin(resources: State['resources'], id: string, rootId: string) {
  const seen = new Set<string>();
  for (let current: string | null = id; current; current = resources[current]?.parentId ?? null) {
    if (current === rootId) return true;
    if (seen.has(current)) throw new RgapError('resource_cycle', 'Resource tree contains a cycle.');
    seen.add(current);
  }
  return false;
}

export function resourcePath(resources: State['resources'], id: string) {
  const names: string[] = [];
  const seen = new Set<string>();
  for (let current: string | null = id; current; current = resources[current]?.parentId ?? null) {
    if (seen.has(current)) throw new RgapError('resource_cycle', 'Resource tree contains a cycle.');
    const resource = resources[current];
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
export function tryResourcePath(resources: State['resources'], id: string) {
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
      if (!state.resources[cap.resourceId]) {
        problems.push(`Grant ${grant.id} refers to missing resource ${cap.resourceId}.`);
      }
    });
  });
  Object.values(state.tokens).forEach((token) => {
    if (!state.grants[token.grantId]) problems.push(`Token ${token.id} refers to missing grant ${token.grantId}.`);
  });
  return problems;
}

/** Resolves a path to a stable resource ID. The root is not a resource, so an empty path resolves to null. */
export function resourceIdAtPath(resources: State['resources'], path: string) {
  let parentId: string | null = null;
  for (const name of pathParts(path)) {
    const match = liveResources(resources).find((item) => item.parentId === parentId && item.name === name);
    if (!match) return null;
    parentId = match.id;
  }
  return parentId;
}

/** Resolves a path that must name an existing resource, such as the target of a move or delete. */
export function requireResourceId(resources: State['resources'], path: string) {
  const id = resourceIdAtPath(resources, path);
  if (!id) throw new RgapError('missing_resource', `No resource exists at ${normalizePath(path) || '/'}.`);
  return id;
}

export const normalizePath = (path: string) => pathParts(path).join('/');

/**
 * Whether every request the child entry authorizes is also authorized by the parent entry.
 * Location containment is required in every case: relocation policy governs what happens to an
 * existing grant when its resource later moves, and never substitutes for containment at issue.
 */
export function covers(parent: Capability, child: Capability, resources: State['resources']) {
  const policyRank: Record<RelocationPolicy, number> = {
    deny_move: 0,
    revoke_on_scope_exit: 1,
    follow_resource: 2,
  };
  const locationCovered = parent.descendants
    ? isWithin(resources, child.resourceId, parent.resourceId)
    : parent.resourceId === child.resourceId && !child.descendants;
  return locationCovered &&
    policyRank[child.relocation] <= policyRank[parent.relocation] &&
    child.permissions.every((permission) => parent.permissions.includes(permission));
}

function lineage(state: State, grantId: string) {
  const result: Grant[] = [];
  const seen = new Set<string>();
  for (let id: string | null = grantId; id; id = state.grants[id]?.parentId ?? null) {
    if (seen.has(id)) throw new RgapError('grant_cycle', 'Grant tree contains a cycle.');
    const grant = state.grants[id];
    if (!grant) throw new RgapError('missing_parent', `Grant ${id} does not exist.`);
    seen.add(id);
    result.push(grant);
  }
  return result;
}

function audit(state: State, event: Omit<AuditEvent, 'id'>) {
  state.audit.unshift({ id: `${event.at}:${event.action}:${state.audit.length}`, ...event });
}

function revokeBranch(state: State, grantId: string, at: string) {
  const ids = new Set([grantId]);
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
  id: string,
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

export function moveResource(state: State, id: string, parentId: string | null, at: string) {
  const resource = state.resources[id];
  if (!isLive(resource)) throw new RgapError('missing_resource', 'Resource does not exist.');
  if (parentId && !isLive(state.resources[parentId])) throw new RgapError('missing_parent', 'Parent resource does not exist.');
  if (parentId === id || (parentId && isWithin(state.resources, parentId, id))) {
    throw new RgapError('resource_cycle', 'A resource cannot move inside itself.');
  }
  const affected = Object.values(state.grants).filter((grant) =>
    active(grant, at) && grant.capabilities.some((cap) => isWithin(state.resources, cap.resourceId, id)),
  );
  if (resource.movePolicy === 'deny_while_granted' && affected.length) {
    throw new RgapError('move_denied', 'This resource cannot move while an active grant covers it.');
  }

  const next = copy(state);
  next.resources[id].parentId = parentId;
  for (const grant of affected.filter((item) => item.parentId)) {
    const parent = next.grants[grant.parentId!];
    const outside = grant.capabilities.filter((cap) =>
      !parent.capabilities.some((parentCap) => covers(parentCap, cap, next.resources)),
    );
    if (outside.some((cap) => cap.relocation === 'deny_move')) {
      throw new RgapError('move_denied', `Grant ${grant.name} prevents this move.`);
    }
    if (outside.some((cap) => cap.relocation === 'revoke_on_scope_exit')) revokeBranch(next, grant.id, at);
  }
  audit(next, { at, action: 'resource.move', target: id, result: 'recorded', detail: `Moved ${resource.name}.` });
  return next;
}

export function deleteResource(state: State, id: string, at: string) {
  const resource = state.resources[id];
  if (!isLive(resource)) throw new RgapError('missing_resource', 'Resource does not exist.');
  const removed = liveResources(state.resources)
    .filter((candidate) => isWithin(state.resources, candidate.id, id))
    .map((candidate) => candidate.id);
  const affected = Object.values(state.grants).filter((grant) =>
    active(grant, at) && grant.capabilities.some((cap) => removed.includes(cap.resourceId)),
  );
  if (resource.deletePolicy === 'deny_while_granted' && affected.length) {
    throw new RgapError('delete_denied', 'This resource cannot be deleted while an active grant covers it.');
  }
  const next = copy(state);
  affected.forEach((grant) => revokeBranch(next, grant.id, at));
  removed.forEach((removedId) => { next.resources[removedId].deletedAt = at; });
  audit(next, { at, action: 'resource.delete', target: id, result: 'recorded', detail: `Deleted ${resource.name} and its descendants.` });
  return next;
}

export function createGrant(state: State, input: CreateGrantInput, id: string, at: string) {
  if (!input.name.trim() || !input.subject.trim()) throw new RgapError('invalid_grant', 'Grant name and subject are required.');
  input.capabilities.forEach((cap) => {
    if (!isLive(state.resources[cap.resourceId])) throw new RgapError('missing_resource', 'Capability resource does not exist.');
    if (!cap.permissions.length) throw new RgapError('invalid_capability', 'Select at least one permission.');
  });
  if (input.parentId) {
    const parent = state.grants[input.parentId];
    if (!parent || !active(parent, at)) throw new RgapError('inactive_parent', 'Parent grant is missing or inactive.');
    if (parent.expiresAt && (!input.expiresAt || input.expiresAt > parent.expiresAt)) {
      throw new RgapError('expiration_expands', 'Child expiration must not exceed its parent.');
    }
    input.capabilities.forEach((cap) => {
      if (!parent.capabilities.some((parentCap) => covers(parentCap, cap, state.resources))) {
        throw new RgapError('authority_expands', 'Child capability is not covered by its parent.');
      }
    });
  }
  const next = copy(state);
  next.grants[id] = { ...input, id, name: input.name.trim(), subject: input.subject.trim(), revokedAt: null };
  audit(next, { at, action: input.parentId ? 'grant.delegate' : 'grant.create', target: id, result: 'recorded', detail: `Created ${input.name}.` });
  return next;
}

/**
 * Replaces a grant's whole capability set in one transition. Identity, subject, parent, and expiry
 * are fixed at issue; what a grant reaches is not, so this runs the same downscoping proof as issue
 * at the moment the set changes, and revokes any child the new set no longer covers.
 */
export function setCapabilities(state: State, grantId: string, capabilities: Capability[], at: string) {
  const grant = state.grants[grantId];
  if (!grant) throw new RgapError('missing_grant', 'Grant does not exist.');
  if (!active(grant, at)) throw new RgapError('inactive_grant', 'A revoked or expired grant is not amended.');
  capabilities.forEach((cap) => {
    if (!isLive(state.resources[cap.resourceId])) throw new RgapError('missing_resource', 'Capability resource does not exist.');
    if (!cap.permissions.length) throw new RgapError('invalid_capability', 'Select at least one permission.');
  });
  if (grant.parentId) {
    const parent = state.grants[grant.parentId];
    if (!parent || !active(parent, at)) throw new RgapError('inactive_parent', 'Parent grant is missing or inactive.');
    capabilities.forEach((cap) => {
      if (!parent.capabilities.some((parentCap) => covers(parentCap, cap, state.resources))) {
        throw new RgapError('authority_expands', 'Capability is not covered by the parent grant.');
      }
    });
  }
  const next = copy(state);
  next.grants[grantId] = { ...grant, capabilities: structuredClone(capabilities) };
  // Only direct children are checked: a deeper grant is covered against its own parent, unchanged here.
  const orphaned = Object.values(state.grants).filter((child) =>
    child.parentId === grantId &&
    active(child, at) &&
    child.capabilities.some((cap) => !capabilities.some((kept) => covers(kept, cap, state.resources))),
  );
  orphaned.forEach((child) => revokeBranch(next, child.id, at));
  audit(next, {
    at, action: 'grant.capabilities', target: grantId, result: 'recorded',
    detail: orphaned.length
      ? `Set ${capabilities.length} entries on ${grant.name}, revoking ${orphaned.map((child) => child.name).join(', ')}.`
      : `Set ${capabilities.length} entries on ${grant.name}.`,
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

export function revokeToken(state: State, id: string, at: string) {
  if (!state.tokens[id]) throw new RgapError('missing_token', 'Token does not exist.');
  const next = copy(state);
  next.tokens[id].revokedAt ||= at;
  audit(next, { at, action: 'token.revoke', target: id, result: 'recorded', detail: `Revoked ${next.tokens[id].label}.` });
  return next;
}

export function revokeGrant(state: State, id: string, at: string) {
  if (!state.grants[id]) throw new RgapError('missing_grant', 'Grant does not exist.');
  const next = copy(state);
  revokeBranch(next, id, at);
  audit(next, { at, action: 'grant.revoke', target: id, result: 'recorded', detail: `Revoked ${state.grants[id].name} and its descendants.` });
  return next;
}

export function authorize(state: State, tokenHash: string, resourceId: string, permission: Permission, at: string): Decision {
  if (!isLive(state.resources[resourceId])) return { allowed: false, detail: 'Resource does not exist.', grantId: null, lineage: [] };
  const token = Object.values(state.tokens).find((item) => item.hash === tokenHash);
  if (!token || !active(token, at)) return { allowed: false, detail: 'Token is unknown, expired, or revoked.', grantId: null, lineage: [] };
  const chain = lineage(state, token.grantId);
  if (chain.some((grant) => !active(grant, at))) {
    return { allowed: false, detail: 'A grant in the delegation chain is expired or revoked.', grantId: token.grantId, lineage: chain.map((grant) => grant.id) };
  }
  const leafCaps = chain[0].capabilities.filter((cap) => cap.permissions.includes(permission) &&
    (cap.resourceId === resourceId || (cap.descendants && isWithin(state.resources, resourceId, cap.resourceId))));
  const allowed = leafCaps.some((leaf) => chain.slice(1).every((grant) =>
    grant.capabilities.some((cap) => covers(cap, leaf, state.resources)),
  ));
  return {
    allowed,
    detail: allowed ? `${permission} is covered by every grant in the chain.` : `No ${permission} capability survives the complete grant chain.`,
    grantId: token.grantId,
    lineage: chain.map((grant) => grant.id),
  };
}

export function inspectAuthority(state: State, tokenHash: string, at: string): AuthorityView {
  const token = Object.values(state.tokens).find((item) => item.hash === tokenHash);
  if (!token || !active(token, at)) {
    return { valid: false, detail: 'Token is unknown, expired, or revoked.', grantId: null, lineage: [], permissions: {} };
  }
  const chain = lineage(state, token.grantId);
  if (chain.some((grant) => !active(grant, at))) {
    return { valid: false, detail: 'A grant in the delegation chain is expired or revoked.', grantId: token.grantId, lineage: chain.map((grant) => grant.id), permissions: {} };
  }
  const effective = Object.fromEntries(liveResources(state.resources).map((resource) => resource.id).flatMap((resourceId) => {
    const allowed = permissions.filter((permission) => authorize(state, tokenHash, resourceId, permission, at).allowed);
    return allowed.length ? [[resourceId, allowed]] : [];
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
  let id = base;
  let suffix = 2;
  while (state.resources[id]) id = `${base}-${suffix++}`;
  return id;
}
