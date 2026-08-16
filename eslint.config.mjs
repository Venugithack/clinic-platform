import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import tablet from './eslint-rules/index.mjs';

export default tseslint.config(
  {
    ignores: ['.next/**', 'node_modules/**', 'next-env.d.ts', 'supabase/**'],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // -------------------------------------------------------------------------
  // Rule 1: one seam. Only lib/db/* talks to Supabase.
  //
  // Broken means a component runs a query with no RLS, no audit and no
  // transaction — and nobody notices until it is in production. This is the
  // enforcement mechanism referred to in BUILD.md §1.1; the directory layout on
  // its own is only a suggestion.
  // -------------------------------------------------------------------------
  {
    files: ['**/*.{ts,tsx}'],
    ignores: ['lib/db/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['@supabase/*', '@supabase/**'],
              message:
                'Only lib/db may import Supabase (PLAN.md §5.3 rule 1). Go through lib/db, or lib/transitions for a state change.',
            },
          ],
        },
      ],
    },
  },

  // -------------------------------------------------------------------------
  // Rule 2: one writer. Screens do not write money or stock directly — they
  // call a transition, which is one plpgsql function in one transaction with
  // its audit row. A raw .rpc() outside lib/transitions is that rule going.
  // -------------------------------------------------------------------------
  {
    files: ['app/**/*.{ts,tsx}', 'components/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='rpc']",
          message:
            'Call a wrapper in lib/transitions rather than .rpc() directly (PLAN.md §5.3 rule 2).',
        },
      ],
    },
  },

  // -------------------------------------------------------------------------
  // The two tablet rules from TABLET.md §8.
  // -------------------------------------------------------------------------
  {
    files: ['app/**/*.tsx', 'components/**/*.tsx'],
    plugins: { tablet },
    rules: {
      'tablet/min-touch-target': 'error',
      'tablet/no-hover-only-affordance': 'error',
    },
  },

  // -------------------------------------------------------------------------
  // Rule 7: patient surfaces default-deny. `findings` and `notes` never leave.
  //
  // PLAN.md §5.3 rule 7 specifies a grep test across app/p/**, and this is it:
  // clinician shorthand is written for the clinician, and the person it is
  // about is not the intended reader.
  // -------------------------------------------------------------------------
  {
    files: ['app/p/**/*.{ts,tsx}', 'app/now/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "Literal[value=/\\b(findings|notes)\\b/]",
          message:
            'Patient-facing surfaces must never reference findings or notes (PLAN.md §5.3 rule 7).',
        },
        {
          selector: "Identifier[name=/^(findings|notes)$/]",
          message:
            'Patient-facing surfaces must never reference findings or notes (PLAN.md §5.3 rule 7).',
        },
      ],
    },
  },

  {
    files: ['**/*.test.ts', 'e2e/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // Build and CI scripts run in Node, not in a tablet browser.
  {
    files: ['scripts/**/*.mjs', '*.config.{ts,mts,mjs}', 'eslint-rules/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly', Buffer: 'readonly' },
    },
  },
);
