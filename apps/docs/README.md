# @rgap/docs

The RGAP documentation website is a Next.js and Fumadocs application. MDX
pages in `content/docs` define the published content, navigation hierarchy,
search index, tables of contents, and LLM-readable Markdown routes.

From the repository root:

```bash
pnpm docs:dev
pnpm docs:build
```

The development server listens on http://localhost:3001 so it can run beside
the RGAP HTTP server on port 3000.
