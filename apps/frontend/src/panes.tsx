import { useState, type ReactNode } from 'react';
import { useShell } from './shell';

export type ExecuteFn = (method: string, call: () => Promise<unknown>) => Promise<boolean>;
export type OperationResponse = { ok: boolean; body: unknown } | null;

/** Runs one repository call, keeping its response for the response pane and the status line. */
export function useOperation() {
  const { setNotice } = useShell();
  const [response, setResponse] = useState<OperationResponse>(null);

  const execute: ExecuteFn = async (method, call) => {
    try {
      const body = await call();
      setResponse({ ok: true, body: body ?? { method, result: 'committed' } });
      setNotice(`${method} committed.`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setResponse({ ok: false, body: { method, error: message } });
      setNotice(message);
      return false;
    }
  };

  return { response, execute };
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

export function Tabs<T extends string>({
  options,
  value,
  onChange,
}: {
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="tabs">
      {options.map((option) => (
        <button
          type="button"
          key={option}
          className={option === value ? 'tab active' : 'tab'}
          onClick={() => onChange(option)}
        >
          {option}
        </button>
      ))}
    </div>
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

export function Execute({ label }: { label: string }) {
  return (
    <button type="submit" className="execute">
      <span>{label}</span>
      <span aria-hidden="true">→</span>
    </button>
  );
}
