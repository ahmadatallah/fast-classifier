import js from '@eslint/js'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'reference/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // core/library code must never depend on the CLI or MCP-server shells
    files: ['src/**'],
    ignores: ['src/cli/**', 'src/mcp-server/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/cli/*', '**/cli', '**/mcp-server/*', '**/mcp-server'],
              message: 'core must not import CLI or MCP-server code',
            },
          ],
        },
      ],
    },
  },
)
