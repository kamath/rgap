import Link from 'next/link';
import {
  ArrowRight,
  Boxes,
  KeyRound,
  Network,
  ShieldCheck,
  Sparkles,
  Terminal,
} from 'lucide-react';

const principles = [
  {
    icon: Network,
    title: 'Hierarchy-aware',
    description:
      'Model files, tools, services, and MCP servers in one resource tree with stable identities.',
  },
  {
    icon: ShieldCheck,
    title: 'Strictly downscoped',
    description:
      'Every delegation is mechanically proven to stay within its parent authority.',
  },
  {
    icon: KeyRound,
    title: 'Immediately revocable',
    description:
      'Opaque credentials resolve through live grant ancestry on every authorization decision.',
  },
];

export default function HomePage() {
  return (
    <main className="relative flex-1 overflow-hidden">
      <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[42rem] bg-[radial-gradient(circle_at_50%_0%,color-mix(in_oklab,var(--color-fd-primary)_17%,transparent),transparent_58%)]" />
      <div className="pointer-events-none absolute inset-0 -z-20 rgap-grid opacity-70" />

      <section className="mx-auto flex max-w-6xl flex-col items-center px-6 pb-24 pt-24 text-center md:pb-32 md:pt-32">
        <div className="mb-7 inline-flex items-center gap-2 rounded-full border border-fd-border bg-fd-background/80 px-3 py-1.5 text-xs font-medium text-fd-muted-foreground shadow-sm backdrop-blur">
          <Sparkles className="size-3.5 text-fd-primary" aria-hidden="true" />
          Capability access built for agent delegation
        </div>

        <h1 className="max-w-4xl text-balance text-5xl font-semibold tracking-[-0.045em] text-fd-foreground sm:text-6xl md:text-7xl">
          Give agents exactly the
          <span className="rgap-gradient-text"> authority they need.</span>
        </h1>
        <p className="mt-7 max-w-2xl text-pretty text-lg leading-8 text-fd-muted-foreground md:text-xl">
          RGAP combines hierarchical resources, attenuated grants, opaque tokens,
          and live revocation in one small authorization model.
        </p>

        <div className="mt-9 flex flex-col gap-3 sm:flex-row">
          <Link
            href="/docs"
            className="group inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-fd-primary px-5 text-sm font-semibold text-fd-primary-foreground shadow-lg shadow-fd-primary/15 transition hover:-translate-y-0.5 hover:shadow-xl"
          >
            Read the docs
            <ArrowRight
              className="size-4 transition-transform group-hover:translate-x-0.5"
              aria-hidden="true"
            />
          </Link>
          <Link
            href="/docs/quickstarts/typescript"
            className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-fd-border bg-fd-background/80 px-5 text-sm font-semibold text-fd-foreground shadow-sm backdrop-blur transition hover:bg-fd-accent"
          >
            <Terminal className="size-4" aria-hidden="true" />
            Quickstart
          </Link>
        </div>

        <div className="relative mt-16 w-full max-w-4xl overflow-hidden rounded-2xl border border-fd-border bg-fd-card/80 p-2 text-left shadow-2xl shadow-black/5 backdrop-blur md:mt-20">
          <div className="flex items-center gap-1.5 border-b border-fd-border px-3 py-2.5">
            <span className="size-2.5 rounded-full bg-rose-400/80" />
            <span className="size-2.5 rounded-full bg-amber-400/80" />
            <span className="size-2.5 rounded-full bg-emerald-400/80" />
            <span className="ml-3 text-[11px] font-medium text-fd-muted-foreground">
              delegate.ts
            </span>
          </div>
          <pre className="whitespace-pre-wrap break-words p-5 text-[13px] leading-7 text-fd-muted-foreground sm:p-7 sm:text-sm">
            <code>{`const model = await admin.resources.create({
  name: 'openai/gpt-5.6-sol',
  executable: {
    runtime: 'openai',
    input: { model: 'gpt-5.6-sol' },
  },
});

const grant = await admin.grants.create({
  name: 'company/platform-team/employee',
  bindings: [{ id: model.id, permissions: ['invoke'] }],
  expiresAt: null,
});

const token = await grant.tokens.create({ label: 'employee' });
const employee = store.as(token.value);
const authorizedModel = await employee.resources.get(model.id);

const response = await authorizedModel.invoke({
  input: {
    prompt: 'Summarize the design notes.',
  },
});`}</code>
          </pre>
        </div>
      </section>

      <section className="border-y border-fd-border bg-fd-muted/35">
        <div className="mx-auto grid max-w-6xl gap-px px-6 py-16 md:grid-cols-3 md:py-20">
          {principles.map(({ icon: Icon, title, description }) => (
            <article key={title} className="px-1 py-6 md:px-8">
              <div className="mb-5 grid size-10 place-items-center rounded-xl border border-fd-border bg-fd-background shadow-sm">
                <Icon className="size-5 text-fd-primary" aria-hidden="true" />
              </div>
              <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
              <p className="mt-2 text-sm leading-6 text-fd-muted-foreground">
                {description}
              </p>
            </article>
          ))}
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-8 px-6 py-24 md:grid-cols-[0.8fr_1.2fr] md:items-center md:py-32">
        <div>
          <div className="mb-5 grid size-11 place-items-center rounded-xl bg-fd-primary text-fd-primary-foreground">
            <Boxes className="size-5" aria-hidden="true" />
          </div>
          <h2 className="text-3xl font-semibold tracking-tight md:text-4xl">
            Two trees. One invariant.
          </h2>
          <p className="mt-4 max-w-lg leading-7 text-fd-muted-foreground">
            Resources describe where objects live. Grants describe where
            authority comes from. Every child grant stays inside the authority
            of every ancestor.
          </p>
          <Link
            href="/docs/concepts/delegation"
            className="mt-6 inline-flex items-center gap-2 text-sm font-semibold text-fd-primary"
          >
            Understand delegation <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>

        <div className="rounded-2xl border border-fd-border bg-fd-card/60 p-6 shadow-xl shadow-black/5 md:p-8">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-xl border border-fd-border bg-fd-background p-5">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-fd-muted-foreground">
                Resource tree
              </div>
              <div className="mt-5 font-mono text-sm leading-7">
                acme/
                <br />
                ├── platform/
                <br />
                │&nbsp;&nbsp; ├── docs/
                <br />
                │&nbsp;&nbsp; └── tools/
                <br />
                └── finance/
              </div>
            </div>
            <div className="rounded-xl border border-fd-border bg-fd-background p-5">
              <div className="text-xs font-semibold uppercase tracking-[0.18em] text-fd-muted-foreground">
                Grant lineage
              </div>
              <div className="mt-5 font-mono text-sm leading-7">
                Company
                <br />
                └── Platform
                <br />
                &nbsp;&nbsp;&nbsp; └── Agent
                <br />
                &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp; └── Sub-agent
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
