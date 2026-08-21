import { useEffect, useState, type ReactNode } from 'react';

export type ExecuteFn = (method: string, call: () => Promise<unknown>) => Promise<boolean>;
export type ExecuteEachFn = <T>(
  method: string,
  items: readonly T[],
  target: (item: T) => string,
  call: (item: T) => Promise<unknown>,
) => Promise<boolean>;
export type OperationResponse = { ok: boolean; body: unknown } | null;

const reason = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Runs repository calls, keeping the response for the surface the command was sent from. */
export function useOperation() {
  const [response, setResponse] = useState<OperationResponse>(null);

  const execute: ExecuteFn = async (method, call) => {
    try {
      const body = await call();
      setResponse({ ok: true, body: body ?? { method, result: 'committed' } });
      return true;
    } catch (error) {
      setResponse({ ok: false, body: { method, error: reason(error) } });
      return false;
    }
  };

  // One command per item, in order, so a selection where some are refused reports which were applied.
  const executeEach: ExecuteEachFn = async (method, items, target, call) => {
    const results: { target: string; ok: boolean; result?: unknown; error?: string }[] = [];
    for (const item of items) {
      try {
        const body = await call(item);
        results.push({ target: target(item), ok: true, result: body ?? 'committed' });
      } catch (error) {
        results.push({ target: target(item), ok: false, error: reason(error) });
      }
    }
    const applied = results.filter((result) => result.ok).length;
    const ok = applied === results.length;
    setResponse({ ok, body: { method, applied: `${applied}/${results.length}`, results } });
    return ok;
  };

  return { response, execute, executeEach };
}

/**
 * The selection a listing's action bar acts on. It is scoped to the location the listing shows, and
 * reading it back out of the live rows drops whatever a committed command removed from it.
 */
export function useSelection<T extends { id: string }>(scope: string, rows: T[]) {
  const [selection, setSelection] = useState<{ scope: string; ids: string[] }>({ scope, ids: [] });
  const held = new Set(selection.scope === scope ? selection.ids : []);
  const targets = rows.filter((row) => held.has(row.id));
  const checked = new Set(targets.map((target) => target.id));

  return {
    targets,
    isChecked: (id: string) => checked.has(id),
    allChecked: Boolean(rows.length) && targets.length === rows.length,
    toggle: (id: string) =>
      setSelection({ scope, ids: checked.has(id) ? [...checked].filter((kept) => kept !== id) : [...checked, id] }),
    toggleAll: () =>
      setSelection({ scope, ids: targets.length === rows.length ? [] : rows.map((row) => row.id) }),
  };
}

/** The facts of the record a route addresses, on one line under the breadcrumb. */
export function ObjectLine({ id, fields }: { id: string; fields: [string, ReactNode][] }) {
  return (
    <p className="object-line">
      <code>{id}</code>
      {fields.map(([label, value]) => (
        <span key={label}>
          <span className="dim"> · {label} </span>
          <code>{value}</code>
        </span>
      ))}
    </p>
  );
}

/** A listing's operations, in the head of the pane that lists what they act on. */
export function Actions({ children }: { children: ReactNode }) {
  return <div className="actions">{children}</div>;
}

export function Action({
  label,
  count,
  open,
  disabled,
  onClick,
}: {
  label: string;
  count?: number;
  open?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button type="button" className={open ? 'action open' : 'action'} disabled={disabled} onClick={onClick}>
      {count ? `${label} ${count}` : label}
    </button>
  );
}

/** A listing row's checkbox. Its own click never reaches the row underneath it. */
export function Check({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      onClick={(event) => event.stopPropagation()}
    />
  );
}

export function PageTitle({ title, note }: { title: string; note: string }) {
  return (
    <div className="page-title">
      <h1>{title}</h1>
      <p>{note}</p>
    </div>
  );
}

export function Pane({
  label,
  meta,
  head,
  children,
  tone,
}: {
  label?: string;
  meta?: ReactNode;
  head?: ReactNode;
  children: ReactNode;
  tone?: 'allowed' | 'denied';
}) {
  return (
    <section className={tone ? `pane ${tone}` : 'pane'}>
      <div className="pane-head">
        {head ?? <span className="pane-label">{label}</span>}
        <span className="pane-meta">{meta}</span>
      </div>
      <div className="pane-body">{children}</div>
    </section>
  );
}

/** One operation, in a pane at the right edge of the route. Escape closes it, as does its own control. */
export function Drawer({
  label,
  meta,
  onClose,
  children,
}: {
  label: string;
  meta?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [onClose]);

  return (
    <section className="pane drawer">
      <div className="pane-head">
        <span className="pane-label">{label}</span>
        <span className="pane-meta">{meta}</span>
        <button type="button" className="drawer-close" onClick={onClose}>
          close
        </button>
      </div>
      <div className="pane-body">{children}</div>
    </section>
  );
}

export function Json({ value, placeholder }: { value: unknown; placeholder?: string }) {
  if (value === undefined || value === null) {
    return <pre className="json placeholder">{placeholder ?? '// nothing yet.'}</pre>;
  }
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

export function ResponsePane({ response }: { response: OperationResponse }) {
  return (
    <Pane
      label="Response"
      meta="@rgap/core rules"
      tone={response ? (response.ok ? 'allowed' : 'denied') : undefined}
    >
      <Json value={response?.body} placeholder="// the parsed response appears here." />
    </Pane>
  );
}

export const plural = (count: number, noun: string) => `${count} ${count === 1 ? noun : `${noun}s`}`;

/** The records an operation will act on, named the way the listing named them. */
export function Targets({ items }: { items: string[] }) {
  return (
    <div className="targets">
      <span className="targets-label">targets</span>
      {items.map((item) => (
        <code key={item}>{item}</code>
      ))}
    </div>
  );
}

/** A drawer's form. Submitting runs the operation; the drawer decides what to do when it commits. */
export function Form({ onSubmit, children }: { onSubmit: () => Promise<void>; children: ReactNode }) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void onSubmit();
      }}
    >
      {children}
    </form>
  );
}

/** The response inside a drawer, where a refused command is the reason the drawer is still open. */
export function ResponseBlock({ response }: { response: OperationResponse }) {
  if (!response) return null;
  return (
    <div className={response.ok ? 'response allowed' : 'response denied'}>
      <span className="response-label">response</span>
      <Json value={response.body} />
    </div>
  );
}

export function Execute({ label }: { label: string }) {
  return (
    <button type="submit" className="execute">
      <span>{label}</span>
      <span aria-hidden="true">→</span>
    </button>
  );
}
