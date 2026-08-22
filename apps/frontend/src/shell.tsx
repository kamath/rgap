import { tokenValue } from '@rgap/core';
import { createContext, useContext, useEffect, useState } from 'react';
import { Link, Outlet } from '@tanstack/react-router';
import { useRgapAuthority, useRgapClient } from '@rgap/react';
import { store } from './repository';

type ShellState = {
  token: string;
  setToken: (value: string) => void;
};

/** Which plane the interface sends commands to. An active token makes every command an authorized one. */
export const usePlane = () => (useShell().token.trim() ? 'guarded' : 'administrative');

const ShellContext = createContext<ShellState | null>(null);

export function useShell() {
  const shell = useContext(ShellContext);
  if (!shell) throw new Error('useShell must be used inside the application shell.');
  return shell;
}

export function Shell() {
  const client = useRgapClient();
  const [token, setToken] = useState('');

  // With no token the interface holds the administrative plane; with one, every command is authorized first.
  useEffect(() => {
    client.setRepository(token.trim() ? store.as(tokenValue(token)) : store.admin());
  }, [client, token]);

  return (
    <ShellContext.Provider value={{ token, setToken }}>
      <Header />
      <main>
        <Outlet />
      </main>
    </ShellContext.Provider>
  );
}

function Header() {
  const client = useRgapClient();
  const { token, setToken } = useShell();
  const { authority } = useRgapAuthority(token);

  const lens = !token.trim()
    ? { tone: 'admin', label: 'administrative view', detail: 'every resource and grant is visible' }
    : !authority
      ? { tone: 'admin', label: 'inspecting', detail: 'resolving authority' }
      : authority.valid
        ? { tone: 'allowed', label: 'token authority', detail: authority.detail }
        : { tone: 'denied', label: 'no authority', detail: authority.detail };

  return (
    <header>
      <div className="header-top">
        <p className="eyebrow">Live protocol workbench</p>
        <div className="token-control">
          <label>
            <span>Active bearer token</span>
            <input
              value={token}
              placeholder="empty for the administrative view"
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <button type="button" className="ghost" onClick={() => setToken('')}>
            Clear
          </button>
          <button
            type="button"
            className="ghost"
            onClick={async () => {
              // Reset is chrome, not an operation: it always runs on the administrative plane.
              await store.admin().reset();
              setToken('');
              await client.refresh();
            }}
          >
            Reset example
          </button>
        </div>
      </div>
      <nav className="tabs">
        <Link to="/browse/$" params={{ _splat: '' }} className="tab" activeProps={{ className: 'tab active' }}>
          Resources
        </Link>
        <Link to="/grants" className="tab" activeProps={{ className: 'tab active' }}>
          Grants
        </Link>
        <Link to="/authorize" className="tab" activeProps={{ className: 'tab active' }}>
          Authorize
        </Link>
        <Link to="/audit" className="tab" activeProps={{ className: 'tab active' }}>
          Audit
        </Link>
        <span className="tab tab-filler" />
      </nav>
      <div className="status">
        <span className={`lens ${lens.tone}`}>
          {lens.label} · {lens.detail}
        </span>
      </div>
    </header>
  );
}
