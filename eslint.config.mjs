import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

import noPrimitiveTokens from './eslint-rules/no-primitive-tokens.mjs';
import tokenFormRule from './eslint-rules/token-form-rule.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    // .verify-build is tsc output for `pnpm verify:script` — CommonJS on purpose, so
    // linting it reports require() as an error against code nobody wrote.
    ignores: [
      'node_modules/**',
      '.next/**',
      'out/**',
      'build/**',
      '.verify-build/**',
      'next-env.d.ts',
    ],
  },
  {
    rules: {
      /**
       * `_`-prefixed arguments are deliberately unused.
       *
       * Not laziness — `useActionState` passes the previous state as the first argument
       * and there is no way to decline it. Naming it `_prev` is the convention for "I know
       * this is here and I am not using it"; without this the only ways to silence it are
       * an inline disable comment on every action or leaving a permanent warning nobody
       * reads, and a lint output with standing noise in it stops being read at all.
       */
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    /**
     * The design-token layer boundary.
     *
     * Scoped to files that render: app routes and components. `src/lib/` is exempt
     * because it holds no markup, and `src/styles/` is exempt because it *is* the token
     * layer. See eslint-rules/no-primitive-tokens.mjs for why this exists at all.
     */
    files: ['src/app/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}'],
    plugins: {
      kiln: {
        rules: {
          'no-primitive-tokens': noPrimitiveTokens,
          'token-form-rule': tokenFormRule,
        },
      },
    },
    rules: {
      'kiln/no-primitive-tokens': 'error',
      'kiln/token-form-rule': 'error',
    },
  },
];

export default eslintConfig;
