import defaultMdxComponents from 'fumadocs-ui/mdx';
import {
  Card as BaseCard,
  type CardProps,
} from 'fumadocs-ui/components/card';
import type { CalloutType } from 'fumadocs-ui/components/callout';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import {
  BookOpen,
  Braces,
  CircleCheck,
  CircleX,
  Info,
  Lightbulb,
  MousePointerClick,
  Network,
  Terminal,
  TriangleAlert,
  Workflow,
  type LucideIcon,
} from 'lucide-react';
import type { MDXComponents } from 'mdx/types';
import type { ComponentProps, HTMLAttributes, ReactNode } from 'react';
import { ExpandableCodeBlock } from './expandable-code-block';
import { cn } from '@/lib/cn';

const cardIcons: Record<string, LucideIcon> = {
  BookOpen,
  Braces,
  MousePointerClick,
  Network,
  Terminal,
  Workflow,
};

function Card({ icon, ...props }: CardProps) {
  const Icon = typeof icon === 'string' ? cardIcons[icon] : undefined;
  const resolvedIcon =
    typeof icon === 'string' ? Icon ? <Icon aria-hidden="true" /> : undefined : icon;

  return <BaseCard icon={resolvedIcon} {...props} />;
}

const calloutStyles: Record<
  CalloutType,
  { icon: LucideIcon; className: string; iconClassName: string }
> = {
  info: {
    icon: Info,
    className: 'border-fd-info/25 bg-fd-info/8',
    iconClassName: 'text-fd-info',
  },
  warn: {
    icon: TriangleAlert,
    className: 'border-fd-warning/25 bg-fd-warning/8',
    iconClassName: 'text-fd-warning',
  },
  warning: {
    icon: TriangleAlert,
    className: 'border-fd-warning/25 bg-fd-warning/8',
    iconClassName: 'text-fd-warning',
  },
  error: {
    icon: CircleX,
    className: 'border-fd-error/25 bg-fd-error/8',
    iconClassName: 'text-fd-error',
  },
  success: {
    icon: CircleCheck,
    className: 'border-fd-success/25 bg-fd-success/8',
    iconClassName: 'text-fd-success',
  },
  idea: {
    icon: Lightbulb,
    className: 'border-fd-idea/25 bg-fd-idea/8',
    iconClassName: 'text-fd-idea',
  },
};

type CalloutContainerProps = Omit<HTMLAttributes<HTMLDivElement>, 'title'> & {
  type?: CalloutType;
  icon?: ReactNode;
};

function CalloutContainer({
  type = 'info',
  icon,
  children,
  className,
  ...props
}: CalloutContainerProps) {
  const style = calloutStyles[type];
  const Icon = style.icon;

  return (
    <div
      {...props}
      className={cn(
        'my-4 flex gap-3 rounded-xl border p-4 text-sm text-fd-card-foreground',
        style.className,
        className,
      )}
    >
      <span className="mt-0.5 shrink-0">
        {icon ?? (
          <Icon className={cn('size-4', style.iconClassName)} aria-hidden="true" />
        )}
      </span>
      <div className="min-w-0 flex-1 space-y-1.5">{children}</div>
    </div>
  );
}

function CalloutTitle({ className, ...props }: ComponentProps<'p'>) {
  return <p className={cn('my-0! font-medium', className)} {...props} />;
}

function CalloutDescription({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'prose-no-margin text-fd-muted-foreground empty:hidden',
        className,
      )}
      {...props}
    />
  );
}

function Callout({
  type,
  icon,
  title,
  children,
  ...props
}: CalloutContainerProps & { title?: ReactNode }) {
  return (
    <CalloutContainer type={type} icon={icon} {...props}>
      {title ? <CalloutTitle>{title}</CalloutTitle> : null}
      <CalloutDescription>{children}</CalloutDescription>
    </CalloutContainer>
  );
}

export function getMDXComponents(components?: MDXComponents) {
  return {
    ...defaultMdxComponents,
    pre: ExpandableCodeBlock,
    Card,
    Callout,
    CalloutContainer,
    CalloutTitle,
    CalloutDescription,
    Step,
    Steps,
    ...components,
  } satisfies MDXComponents;
}

export const useMDXComponents = getMDXComponents;

declare global {
  type MDXProvidedComponents = ReturnType<typeof getMDXComponents>;
}
