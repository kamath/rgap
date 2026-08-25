import { RootProvider } from 'fumadocs-ui/provider/next';
import './global.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3001',
  ),
  title: {
    default: 'RGAP — Hierarchical capability access',
    template: '%s · RGAP',
  },
  description:
    'Authorization for resources, tools, and agents with strict downscoping and immediate hierarchical revocation.',
  openGraph: {
    title: 'RGAP — Hierarchical capability access',
    description:
      'Authorization for resources, tools, and agents with strict downscoping and immediate hierarchical revocation.',
    type: 'website',
  },
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>{children}</RootProvider>
      </body>
    </html>
  );
}
