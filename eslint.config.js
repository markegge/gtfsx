import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // react-hooks 7.1's `set-state-in-effect` flags 42 pre-existing call
      // sites, and every one is a legitimate effect pattern rather than the
      // derived-state antipattern the rule targets: data-fetch effects that set
      // `loading`/reset state before an await, syncing to external stores (URL,
      // sessionStorage, props), post-render imperative work (scroll, Mapbox
      // draw, DOM measurement), and run-once guards. None can be rewritten as a
      // render-time computation without changing behavior, so per-site disables
      // would be 42 lines of pure noise. Off by policy; reach for
      // `useSyncExternalStore`/render-time derivation on new code instead.
      'react-hooks/set-state-in-effect': 'off',
      // Allow underscore-prefixed identifiers as intentionally-unused — repo
      // convention for required-but-unused function args and destructured
      // fields (e.g., `_ctx: ExecutionContext`, `{ isTimepoint: _isTimepoint }`).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
    },
  },
])
