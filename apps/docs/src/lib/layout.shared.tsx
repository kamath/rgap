import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { Network } from 'lucide-react';
import { appName, gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-2.5 font-semibold tracking-tight">
          <span className="grid size-7 place-items-center rounded-lg bg-fd-primary text-fd-primary-foreground shadow-sm">
            <Network className="size-4" aria-hidden="true" />
          </span>
          <span>{appName}</span>
          <span className="hidden rounded-full border border-fd-border bg-fd-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.16em] text-fd-muted-foreground sm:inline">
            Docs
          </span>
        </span>
      ),
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
