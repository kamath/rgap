import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="font-semibold tracking-[-0.02em]">{appName}</span>
      ),
    },
    searchToggle: {
      full: {
        className:
          'h-10 w-full rounded-xl border-fd-border/60 bg-fd-background/65 px-3 shadow-[0_1px_2px_color-mix(in_oklab,var(--color-fd-foreground)_4%,transparent)] backdrop-blur transition-all hover:border-fd-border hover:bg-fd-background hover:shadow-sm',
      },
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
