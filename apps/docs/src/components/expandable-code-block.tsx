'use client';

import { CodeBlock } from 'fumadocs-ui/components/codeblock';
import { Maximize2, Minimize2 } from 'lucide-react';
import type { HTMLAttributes } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

const previewHeight = 288;

export function ExpandableCodeBlock({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLPreElement>) {
  const codeRef = useRef<HTMLPreElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [canExpand, setCanExpand] = useState(false);

  const measure = useCallback(() => {
    setCanExpand((codeRef.current?.scrollHeight ?? 0) > previewHeight);
  }, []);

  useEffect(() => {
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [children, measure]);

  return (
    <div className="relative">
      <CodeBlock
        {...props}
        className={className}
        viewportProps={{
          className: cn(
            '!overflow-hidden transition-[max-height] duration-200',
            canExpand && 'pb-14',
            canExpand && !expanded ? '!max-h-72' : '!max-h-none',
          ),
          style: {
            overflow: 'hidden',
            maxHeight: canExpand && !expanded ? previewHeight : 'none',
          },
        }}
      >
        <pre
          ref={codeRef}
          className="w-full min-w-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] *:flex *:min-w-0 *:flex-col [&_.line]:whitespace-pre-wrap [&_.line]:break-words [&_.line]:[overflow-wrap:anywhere]"
        >
          {children}
        </pre>
      </CodeBlock>

      {canExpand ? (
        <>
          {!expanded ? (
            <div className="pointer-events-none absolute inset-x-px bottom-px h-20 rounded-b-xl bg-gradient-to-t from-fd-card via-fd-card/95 to-transparent" />
          ) : null}
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            className="absolute bottom-3 left-1/2 z-10 inline-flex -translate-x-1/2 items-center gap-2 rounded-lg border border-fd-border bg-fd-background px-3 py-1.5 text-xs font-medium text-fd-foreground shadow-sm transition-colors hover:bg-fd-accent"
          >
            {expanded ? (
              <Minimize2 className="size-3.5" aria-hidden="true" />
            ) : (
              <Maximize2 className="size-3.5" aria-hidden="true" />
            )}
            {expanded ? 'Collapse code' : 'Expand code'}
          </button>
        </>
      ) : null}
    </div>
  );
}
