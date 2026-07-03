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
    // house style: arrow-const functions and factories; classes only for Error subtypes
    files: ['src/**', 'test/**'],
    rules: {
      'func-style': ['error', 'expression'],
      'no-restricted-syntax': [
        'error',
        {
          selector: "ClassDeclaration:not([superClass.name='Error'])",
          message:
            'prefer factory functions returning an interface; classes only for Error subtypes',
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
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
