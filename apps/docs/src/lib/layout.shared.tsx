import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="text-[0.9375rem] font-semibold tracking-[-0.025em]">
          {appName}
        </span>
      ),
    },
    searchToggle: {
      full: {
        className:
          'h-9 w-full rounded-lg border-fd-border/60 bg-fd-muted/40 px-3 shadow-none transition-colors hover:border-fd-border hover:bg-fd-muted/70',
      },
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
