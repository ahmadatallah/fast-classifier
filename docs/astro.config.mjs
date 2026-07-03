// @ts-check
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'
import starlightTypeDoc, { typeDocSidebarGroup } from 'starlight-typedoc'

export default defineConfig({
  site: 'https://ahmadatallah.github.io',
  // GitHub Pages project sites live under /fast-classifier — but locally that
  // base makes every URL awkward (/fast-classifier/quickstart/). CI sets
  // DOCS_BASE; local dev/preview serves at the root. Content links are all
  // page-relative, so they resolve correctly under either base.
  ...(process.env.DOCS_BASE ? { base: process.env.DOCS_BASE } : {}),
  integrations: [
    starlight({
      title: 'fast-classifier',
      logo: {
        light: './src/assets/logo-light.svg',
        dark: './src/assets/logo-dark.svg',
        alt: '',
      },
      description:
        'Deterministic, rule-first email classifier for Fastmail: sweep newsletters, file everything into labels, flag what needs action — dry-run first, never deletes.',
      social: [
        {
          icon: 'github',
          label: 'GitHub',
          href: 'https://github.com/ahmadatallah/fast-classifier',
        },
      ],
      editLink: {
        baseUrl: 'https://github.com/ahmadatallah/fast-classifier/edit/main/docs/',
      },
      // "Audit Ledger" theme: self-hosted fonts must load before the
      // stylesheet that references them.
      customCss: [
        '@fontsource-variable/jetbrains-mono',
        '@fontsource-variable/inter',
        './src/styles/custom.css',
      ],
      components: {
        Hero: './src/components/Hero.astro',
      },
      expressiveCode: {
        themes: ['github-dark', 'github-light'],
        // keep code-block chrome (titlebars, tabs, buttons) on our --sl-color-*
        // palette instead of the syntax theme's own UI colors
        useStarlightUiThemeColors: true,
        styleOverrides: {
          borderRadius: '0',
          borderColor: 'var(--sl-color-hairline)',
          codeFontFamily: "'JetBrains Mono Variable', ui-monospace, monospace",
          uiFontFamily: "'JetBrains Mono Variable', ui-monospace, monospace",
        },
      },
      plugins: [
        starlightTypeDoc({
          entryPoints: [
            '../src/index.ts',
            '../src/provider/jmap/index.ts',
            '../src/provider/mcp/index.ts',
            '../src/provider/memory.ts',
          ],
          tsconfig: '../tsconfig.build.json',
          output: 'api',
          sidebar: {
            label: 'API Reference',
            collapsed: true,
          },
          typeDoc: {
            readme: 'none',
            gitRevision: 'main',
            // With multiple entry points and no readme, starlight-typedoc removes
            // per-module `README.md` pages while the generated root page still links
            // to them (broken links). A custom entry file name keeps the module
            // landing pages. It must not be `index`: the module generated from
            // src/index.ts would emit `api/index/index.md`, which collides with the
            // root `api/index.md` route.
            entryFileName: 'overview',
          },
        }),
      ],
      sidebar: [
        {
          label: 'Start Here',
          items: [
            { label: 'Quickstart', slug: 'quickstart' },
            { label: 'Safety Model', slug: 'safety' },
          ],
        },
        {
          label: 'Guides',
          items: [
            { label: 'Configuration', slug: 'guides/configuration' },
            { label: 'CLI Reference', slug: 'guides/cli' },
            { label: 'MCP Server', slug: 'guides/mcp-server' },
            { label: 'Transports', slug: 'guides/transports' },
          ],
        },
        {
          label: 'Core Concepts',
          items: [{ autogenerate: { directory: 'concepts' } }],
        },
        {
          label: 'Appendix',
          items: [{ label: 'Fastmail Quirks', slug: 'appendix/quirks' }],
        },
        typeDocSidebarGroup,
      ],
    }),
  ],
})
