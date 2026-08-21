import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import {
  permissions,
  resourcePath,
  type AuthorityView,
  type Capability,
  type Decision,
  type Permission,
  type Resource,
  type State,
} from './domain';
import type { RgapRepository } from './repository';

type View = 'resources' | 'grants' | 'simulator' | 'audit';

export function App({ repository }: { repository: RgapRepository }) {
  const state = useSyncExternalStore(repository.subscribe, repository.getSnapshot);
  const [view, setView] = useState<View>('resources');
  const [token, setToken] = useState('');
  const [authority, setAuthority] = useState<AuthorityView | null>(null);
  const [message, setMessage] = useState('Ready. State is stored in this browser.');

  useEffect(() => {
    if (!token.trim()) {
      setAuthority(null);
      return;
    }
    setAuthority(null);
    let current = true;
    repository.inspectToken(token).then((result) => { if (current) setAuthority(result); });
    return () => { current = false; };
  }, [repository, state, token]);

  async function run(action: () => Promise<unknown>, success: string) {
    try {
      await action();
      setMessage(success);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function issue(grantId: string) {
    try {
      const issued = await repository.issueToken(grantId, `${state.grants[grantId].name} token`);
      setToken(issued.value);
      setMessage(`Issued and activated a token for ${state.grants[grantId].name}.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    }
  }

  const admin = !token.trim();
  const lens = admin ? 'Admin view' : authority?.valid ? `Token: ${state.grants[authority.grantId!]?.name}` : 'No authority';

  return (
    <main>
      <header>
        <div>
          <p className="eyebrow">Reference implementation</p>
          <h1>RGAP interface test bed</h1>
          <p>Change the active bearer token to inspect a different authority view.</p>
        </div>
        <button className="secondary" onClick={() => run(async () => { await repository.reset(); setToken(''); }, 'Example state restored.')}>Reset example</button>
      </header>

      <section className="token-lens">
        <label>
          <span>Active bearer token</span>
          <input value={token} onChange={(event) => setToken(event.target.value)} placeholder="Blank = unrestricted admin view" spellCheck={false} />
        </label>
        {token && <button className="secondary" onClick={() => setToken('')}>Clear</button>}
        <div className={`lens-state ${admin || authority?.valid ? 'good' : 'bad'}`}>
          <strong>{lens}</strong>
          <small>{admin ? 'All resources and grants are visible.' : authority?.detail ?? 'Checking token…'}</small>
        </div>
      </section>

      <nav aria-label="Sections">
        {(['resources', 'grants', 'simulator', 'audit'] as View[]).map((item) => (
          <button className={view === item ? 'active' : ''} onClick={() => setView(item)} key={item}>{item}</button>
        ))}
      </nav>
      <p className="status" role="status">{message}</p>

      {view === 'resources' && <Resources state={state} repository={repository} authority={authority} admin={admin} run={run} />}
      {view === 'grants' && <Grants state={state} repository={repository} authority={authority} admin={admin} run={run} issue={issue} />}
      {view === 'simulator' && <Simulator state={state} repository={repository} token={token} setMessage={setMessage} />}
      {view === 'audit' && <Audit state={state} />}
    </main>
  );
}

function Resources({ state, repository, authority, admin, run }: {
  state: State;
  repository: RgapRepository;
  authority: AuthorityView | null;
  admin: boolean;
  run: Runner;
}) {
  const visible = useMemo(() => visibleResourceIds(state, admin, authority), [state, admin, authority]);
  const resources = Object.values(state.resources).filter((item) => visible.has(item.id));
  const [selectedId, setSelectedId] = useState(resources[0]?.id ?? '');
  const selected = state.resources[selectedId] && visible.has(selectedId) ? state.resources[selectedId] : resources[0];
  const paths = allPaths(state);

  return (
    <section className="resource-layout">
      <div className="tree-panel">
        <div className="section-heading">
          <div><h2>Resources</h2><p className="hint">{admin ? 'Complete resource tree' : 'Authorized resources and their parent paths'}</p></div>
          <span>{resources.length} visible</span>
        </div>
        {!resources.length && <Empty text="This token has no visible resources." />}
        <div className="file-tree">
          {resources.filter((item) => !item.parentId || !visible.has(item.parentId)).map((root) => (
            <TreeNode key={root.id} resource={root} state={state} visible={visible} authority={authority} selectedId={selected?.id} onSelect={setSelectedId} />
          ))}
        </div>
        <PathOptions paths={paths} />
      </div>

      <aside className="resource-sidebar">
        {selected && <ResourceDetails resource={selected} state={state} repository={repository} admin={admin} run={run} />}
        {admin ? <CreateResource repository={repository} run={run} onCreated={setSelectedId} /> : <div className="panel"><h2>Read-only token view</h2><p className="hint">Clear the active token to create, move, or delete resources.</p></div>}
      </aside>
    </section>
  );
}

function TreeNode({ resource, state, visible, authority, selectedId, onSelect }: {
  resource: Resource;
  state: State;
  visible: Set<string>;
  authority: AuthorityView | null;
  selectedId?: string;
  onSelect: (id: string) => void;
}) {
  const children = Object.values(state.resources)
    .filter((item) => item.parentId === resource.id && visible.has(item.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const effective = authority?.permissions[resource.id] ?? [];
  return (
    <div className="tree-branch">
      <button className={`tree-row ${selectedId === resource.id ? 'selected' : ''}`} onClick={() => onSelect(resource.id)}>
        <span className="tree-icon">{children.length ? '▾' : '·'}</span>
        <span className="tree-name">{resource.name}</span>
        {effective.length > 0 && <span className="permission-list">{effective.join(' · ')}</span>}
      </button>
      {children.length > 0 && <div className="tree-children">{children.map((child) => <TreeNode key={child.id} resource={child} state={state} visible={visible} authority={authority} selectedId={selectedId} onSelect={onSelect} />)}</div>}
    </div>
  );
}

function ResourceDetails({ resource, state, repository, admin, run }: {
  resource: Resource;
  state: State;
  repository: RgapRepository;
  admin: boolean;
  run: Runner;
}) {
  const [destination, setDestination] = useState(resource.parentId ? resourcePath(state.resources, resource.parentId) : '');
  useEffect(() => setDestination(resource.parentId ? resourcePath(state.resources, resource.parentId) : ''), [resource, state]);
  return (
    <div className="panel details">
      <p className="eyebrow">Selected resource</p>
      <h2>{resource.name}</h2>
      <dl>
        <dt>Path</dt><dd>{resourcePath(state.resources, resource.id)}</dd>
        <dt>Stable ID</dt><dd><code>{resource.id}</code></dd>
        <dt>Move policy</dt><dd><code>{resource.movePolicy}</code></dd>
        <dt>Delete policy</dt><dd><code>{resource.deletePolicy}</code></dd>
      </dl>
      {admin && <>
        <Field label="Move under path"><input list="resource-paths" value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="Blank for root" /></Field>
        <div className="button-row">
          <button className="secondary" onClick={() => run(() => repository.moveResource(resource.id, destination), `Moved ${resource.name}.`)}>Move</button>
          <button className="danger" onClick={() => run(() => repository.deleteResource(resource.id), `Deleted ${resource.name}.`)}>Delete</button>
        </div>
      </>}
    </div>
  );
}

function CreateResource({ repository, run, onCreated }: { repository: RgapRepository; run: Runner; onCreated: (id: string) => void }) {
  const [name, setName] = useState('');
  const [parentPath, setParentPath] = useState('');
  const [movePolicy, setMovePolicy] = useState<Resource['movePolicy']>('normal');
  const [deletePolicy, setDeletePolicy] = useState<Resource['deletePolicy']>('revoke');

  async function submit(event: FormEvent) {
    event.preventDefault();
    const resourceName = name;
    await run(async () => {
      const resource = await repository.createResource({ name, parentPath, movePolicy, deletePolicy });
      onCreated(resource.id);
    }, `Created ${resourceName}.`);
    setName('');
  }

  return (
    <form onSubmit={submit}>
      <h2>Create resource</h2>
      <Field label="Name"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="search_files" required /></Field>
      <Field label="Parent path"><input list="resource-paths" value={parentPath} onChange={(event) => setParentPath(event.target.value)} placeholder="acme/mcp/google-drive/tools" /></Field>
      <p className="field-note">Type a new path to create its missing resource segments.</p>
      <Field label="Move policy"><select value={movePolicy} onChange={(event) => setMovePolicy(event.target.value as Resource['movePolicy'])}><option value="normal">normal</option><option value="deny_while_granted">deny_while_granted</option></select></Field>
      <Field label="Delete policy"><select value={deletePolicy} onChange={(event) => setDeletePolicy(event.target.value as Resource['deletePolicy'])}><option value="revoke">revoke</option><option value="deny_while_granted">deny_while_granted</option></select></Field>
      <button>Create resource</button>
    </form>
  );
}

function Grants({ state, repository, authority, admin, run, issue }: {
  state: State;
  repository: RgapRepository;
  authority: AuthorityView | null;
  admin: boolean;
  run: Runner;
  issue: (grantId: string) => Promise<void>;
}) {
  const visible = new Set(admin ? Object.keys(state.grants) : authority?.lineage ?? []);
  const roots = Object.values(state.grants).filter((grant) => visible.has(grant.id) && (!grant.parentId || !visible.has(grant.parentId)));
  return (
    <section className="layout">
      <div>
        <div className="section-heading"><div><h2>Grant lineage</h2><p className="hint">{admin ? 'All grants' : 'Lineage for the active token'}</p></div></div>
        {!roots.length && <Empty text="This token has no active grant lineage." />}
        {roots.map((grant) => <GrantNode key={grant.id} grantId={grant.id} visible={visible} state={state} repository={repository} run={run} issue={issue} />)}
        {admin && <TokenRecords state={state} repository={repository} run={run} />}
      </div>
      <GrantForm state={state} repository={repository} authority={authority} admin={admin} run={run} />
    </section>
  );
}

function GrantForm({ state, repository, authority, admin, run }: {
  state: State;
  repository: RgapRepository;
  authority: AuthorityView | null;
  admin: boolean;
  run: Runner;
}) {
  const parentOptions = Object.values(state.grants).filter((grant) => admin || authority?.lineage.includes(grant.id));
  const resourceOptions = Object.values(state.resources).filter((resource) => admin || authority?.permissions[resource.id]);
  const [name, setName] = useState('');
  const [subject, setSubject] = useState('');
  const [parentId, setParentId] = useState(admin ? '' : authority?.grantId ?? '');
  const [resourceId, setResourceId] = useState(resourceOptions[0]?.id ?? '');
  const [selectedPermissions, setSelectedPermissions] = useState<Permission[]>(['read']);
  const [descendants, setDescendants] = useState(false);
  const [relocation, setRelocation] = useState<Capability['relocation']>('revoke_on_scope_exit');
  const [expiresAt, setExpiresAt] = useState('');

  useEffect(() => {
    setParentId(admin ? '' : authority?.grantId ?? '');
    const nextResource = resourceOptions.some((resource) => resource.id === resourceId)
      ? resourceId
      : resourceOptions[0]?.id ?? '';
    setResourceId(nextResource);
    if (!admin && nextResource) setSelectedPermissions(authority?.permissions[nextResource] ?? []);
  }, [admin, authority]);

  function togglePermission(permission: Permission) {
    setSelectedPermissions((current) => current.includes(permission)
      ? current.filter((item) => item !== permission)
      : [...current, permission]);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const grantName = name;
    const parent = parentId ? state.grants[parentId] : null;
    const expiration = expiresAt ? new Date(expiresAt).toISOString() : parent?.expiresAt ?? null;
    await run(() => repository.createGrant({
      name,
      subject,
      parentId: parentId || null,
      expiresAt: expiration,
      capabilities: [{ resourceId, permissions: selectedPermissions, descendants, relocation }],
    }), `Created ${grantName}.`);
    setName('');
    setSubject('');
  }

  const usable = admin || Boolean(authority?.valid);
  return (
    <form onSubmit={submit}>
      <h2>{parentId ? 'Delegate grant' : 'Create root grant'}</h2>
      {!usable && <p className="bad">Enter a valid token or clear it for admin view.</p>}
      <Field label="Name"><input value={name} onChange={(event) => setName(event.target.value)} required disabled={!usable} /></Field>
      <Field label="Subject"><input value={subject} onChange={(event) => setSubject(event.target.value)} required disabled={!usable} /></Field>
      <Field label="Parent grant">
        <select value={parentId} onChange={(event) => setParentId(event.target.value)} disabled={!usable}>
          {admin && <option value="">None (root grant)</option>}
          {parentOptions.map((grant) => <option key={grant.id} value={grant.id}>{grant.name}</option>)}
        </select>
      </Field>
      <Field label="Resource">
        <select value={resourceId} onChange={(event) => {
          setResourceId(event.target.value);
          if (!admin) setSelectedPermissions(authority?.permissions[event.target.value] ?? []);
        }} disabled={!usable}>
          {resourceOptions.map((resource) => <option key={resource.id} value={resource.id}>{resourcePath(state.resources, resource.id)}</option>)}
        </select>
      </Field>
      <fieldset disabled={!usable}>
        <legend>Permissions</legend>
        <div className="checks">{permissions.map((permission) => <label key={permission}><input type="checkbox" checked={selectedPermissions.includes(permission)} onChange={() => togglePermission(permission)} /> {permission}</label>)}</div>
      </fieldset>
      <label className="check"><input type="checkbox" checked={descendants} onChange={(event) => setDescendants(event.target.checked)} disabled={!usable} /> Include descendants</label>
      <Field label="Relocation policy">
        <select value={relocation} onChange={(event) => setRelocation(event.target.value as Capability['relocation'])} disabled={!usable}>
          <option value="revoke_on_scope_exit">revoke_on_scope_exit</option>
          <option value="deny_move">deny_move</option>
          <option value="follow_resource">follow_resource</option>
        </select>
      </Field>
      <Field label="Expires"><input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} disabled={!usable} /></Field>
      <button disabled={!usable || !resourceId || !selectedPermissions.length}>Create grant</button>
    </form>
  );
}

function GrantNode({ grantId, visible, state, repository, run, issue }: {
  grantId: string; visible: Set<string>; state: State; repository: RgapRepository; run: Runner; issue: (id: string) => Promise<void>;
}) {
  const grant = state.grants[grantId];
  const children = Object.values(state.grants).filter((item) => item.parentId === grantId && visible.has(item.id));
  return <div className="grant-node"><div className="record"><span><strong>{grant.name}</strong> <code>{grant.id}</code><br /><small>{grant.subject} · {grant.capabilities.length} capabilities</small></span><span>{grant.revokedAt ? <b className="bad">revoked</b> : <b className="good">active</b>} <button className="secondary" onClick={() => issue(grant.id)}>Issue + activate token</button> <button className="danger" onClick={() => run(() => repository.revokeGrant(grant.id), `Revoked ${grant.name}.`)}>Revoke</button></span></div><ul>{grant.capabilities.map((cap, index) => <li key={index}><code>{resourcePath(state.resources, cap.resourceId)}</code>: {cap.permissions.join(', ')}{cap.descendants ? ' + descendants' : ''}</li>)}</ul>{children.map((child) => <GrantNode key={child.id} grantId={child.id} visible={visible} state={state} repository={repository} run={run} issue={issue} />)}</div>;
}

function TokenRecords({ state, repository, run }: { state: State; repository: RgapRepository; run: Runner }) {
  return <div className="token-records"><h2>Token records</h2>{Object.values(state.tokens).map((token) => <div className="record" key={token.id}><span><strong>{token.label}</strong> → {state.grants[token.grantId]?.name ?? token.grantId}</span><span>{token.revokedAt ? <b className="bad">revoked</b> : <b className="good">active</b>} <button className="danger" onClick={() => run(() => repository.revokeToken(token.id), `Revoked ${token.label}.`)}>Revoke</button></span></div>)}</div>;
}

function Simulator({ state, repository, token, setMessage }: { state: State; repository: RgapRepository; token: string; setMessage: (value: string) => void }) {
  const [resourceId, setResourceId] = useState('search-files');
  const [permission, setPermission] = useState<Permission>('invoke');
  const [decision, setDecision] = useState<Decision | null>(null);
  useEffect(() => setDecision(null), [token]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token) return setMessage('Enter or issue an active bearer token first.');
    const result = await repository.authorize(token, resourceId, permission);
    setDecision(result);
    setMessage(result.allowed ? 'Authorization allowed.' : 'Authorization denied.');
  }
  return <section className="layout"><form onSubmit={submit}><h2>Authorization request</h2><p className="hint">Uses the active token above.</p><Field label="Resource"><select value={resourceId} onChange={(event) => setResourceId(event.target.value)}>{Object.values(state.resources).map((resource) => <option key={resource.id} value={resource.id}>{resourcePath(state.resources, resource.id)}</option>)}</select></Field><Field label="Permission"><select value={permission} onChange={(event) => setPermission(event.target.value as Permission)}>{permissions.map((item) => <option key={item}>{item}</option>)}</select></Field><button>Authorize</button></form><div><h2>Decision</h2>{!decision && <p className="hint">Submit a request to inspect the decision.</p>}{decision && <div className={`decision ${decision.allowed ? 'allow' : 'deny'}`}><strong>{decision.allowed ? 'ALLOW' : 'DENY'}</strong><p>{decision.detail}</p><small>Lineage: {decision.lineage.join(' → ') || 'none'}</small></div>}</div></section>;
}

function Audit({ state }: { state: State }) {
  return <section><h2>Audit events</h2><div className="audit">{state.audit.map((event) => <div className="record" key={event.id}><span><b className={event.result === 'denied' ? 'bad' : event.result === 'allowed' ? 'good' : ''}>{event.result}</b> <strong>{event.action}</strong> · <code>{event.target}</code><br /><small>{event.detail}</small></span><time>{new Date(event.at).toLocaleString()}</time></div>)}</div></section>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label><span>{label}</span>{children}</label>;
}

const PathOptions = ({ paths }: { paths: string[] }) => <datalist id="resource-paths">{paths.map((path) => <option key={path} value={path} />)}</datalist>;
const Empty = ({ text }: { text: string }) => <div className="empty"><strong>No results</strong><p>{text}</p></div>;
type Runner = (action: () => Promise<unknown>, success: string) => Promise<void>;

function allPaths(state: State) {
  return Object.keys(state.resources).map((id) => resourcePath(state.resources, id)).sort();
}

function visibleResourceIds(state: State, admin: boolean, authority: AuthorityView | null) {
  if (admin) return new Set(Object.keys(state.resources));
  const ids = new Set(Object.keys(authority?.permissions ?? {}));
  for (const id of [...ids]) {
    for (let parentId = state.resources[id]?.parentId; parentId; parentId = state.resources[parentId]?.parentId ?? null) ids.add(parentId);
  }
  return ids;
}
