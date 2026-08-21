import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { AuthorityView, RgapRepository } from '@rgap/core';

const RepositoryContext = createContext<RgapRepository | null>(null);

export function RgapProvider({ repository, children }: { repository: RgapRepository; children: ReactNode }) {
  return <RepositoryContext.Provider value={repository}>{children}</RepositoryContext.Provider>;
}

export function useRgapRepository() {
  const repository = useContext(RepositoryContext);
  if (!repository) throw new Error('useRgapRepository must be used inside RgapProvider.');
  return repository;
}

export function useRgapSnapshot() {
  const repository = useRgapRepository();
  return useSyncExternalStore(repository.subscribe, repository.getSnapshot);
}

export function useRgapAuthority(token: string) {
  const repository = useRgapRepository();
  const snapshot = useRgapSnapshot();
  const [authority, setAuthority] = useState<AuthorityView | null>(null);

  useEffect(() => {
    if (!token.trim()) {
      setAuthority(null);
      return;
    }
    setAuthority(null);
    let current = true;
    repository.inspectToken(token).then((result) => { if (current) setAuthority(result); });
    return () => { current = false; };
  }, [repository, snapshot, token]);

  return { authority, loading: Boolean(token.trim()) && !authority };
}
