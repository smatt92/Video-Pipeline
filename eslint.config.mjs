import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { FlatCompat } from '@eslint/eslintrc';

import noPrimitiveTokens from './eslint-rules/no-primitive-tokens.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({ baseDirectory: __dirname });

const eslintConfig = [
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    ignores: ['node_modules/**', '.next/**', 'out/**', 'build/**', 'next-env.d.ts'],
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
      kiln: { rules: { 'no-primitive-tokens': noPrimitiveTokens } },
    },
    rules: {
      'kiln/no-primitive-tokens': 'error',
    },
  },
];

export default eslintConfig;
