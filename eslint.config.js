import { builtinModules } from 'node:module';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintReact from '@eslint-react/eslint-plugin';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  prettierConfig,
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/.turbo/**', '**/coverage/**'],
  },
  {
    languageOptions: {
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      '@typescript-eslint/require-await': 'off',
      // Disable overly pedantic rules
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/dot-notation': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/array-type': 'off',
      '@typescript-eslint/prefer-regexp-exec': 'off',
      '@typescript-eslint/no-inferrable-types': 'off',
      '@typescript-eslint/non-nullable-type-assertion-style': 'off',
      '@typescript-eslint/no-unnecessary-type-conversion': 'off',
      // Warn instead of error for unsafe rules (too many to fix at once)
      '@typescript-eslint/no-unsafe-member-access': 'warn',
      '@typescript-eslint/no-unsafe-call': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      '@typescript-eslint/no-unsafe-return': 'warn',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',
      // Stylistic rules that are too noisy
      '@typescript-eslint/return-await': 'warn',
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'warn',
      '@typescript-eslint/no-unnecessary-type-parameters': 'warn',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/prefer-nullish-coalescing': 'off',
      '@typescript-eslint/no-invalid-void-type': 'off',
      // Transitional: warn on @deprecated usage during multi-server migration
      '@typescript-eslint/no-deprecated': 'warn',
    },
  },
  {
    files: ['**/*.tsx', '**/*.jsx'],
    plugins: {
      'react-hooks': reactHooksPlugin,
      ...eslintReact.configs['recommended-typescript'].plugins,
    },
    settings: {
      ...eslintReact.configs['recommended-typescript'].settings,
    },
    rules: {
      ...reactHooksPlugin.configs.recommended.rules,
      ...eslintReact.configs['recommended-typescript'].rules,
      // @eslint-react owns every rule both plugins ship, leaving react-hooks the
      // four React Compiler rules it has no equivalent for.
      ...eslintReact.configs['disable-conflict-eslint-plugin-react-hooks'].rules,
      // The remaining two React Compiler rules. @eslint-react reports the rest of
      // this family as warnings; these two have no equivalent there and fire on
      // patterns the codebase has not worked through yet.
      'react-hooks/react-compiler': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
    },
  },
  {
    files: [
      '**/*.test.ts',
      '**/*.test.tsx',
      '**/test/**/*.ts',
      '**/__tests__/**/*.ts',
      'packages/test-utils/**/*.ts',
    ],
    rules: {
      // Unbound method warnings in tests are false positives when passing to mock callbacks
      '@typescript-eslint/unbound-method': 'off',
      // Non-null assertions are practical in tests where setup guarantees values exist
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Mocking libraries return `any` types - fighting this provides little value in tests
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      // Sometimes needed for dynamic test data or complex mocks
      '@typescript-eslint/no-explicit-any': 'off',
      // Generic type parameter precision is less important in test utilities
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
    },
  },
  {
    // @tracearr/shared runs in the browser and in React Native as well as node,
    // so its production code stays off node builtins and node globals. Its tests
    // are node-only and may reach for zlib and crypto.
    files: ['packages/shared/src/**/*.ts'],
    ignores: ['packages/shared/src/**/__tests__/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: builtinModules,
          patterns: [
            {
              group: ['node:*'],
              message: 'shared ships to browsers and React Native; keep node builtins out',
            },
          ],
        },
      ],
      'no-restricted-globals': ['error', 'Buffer', 'process', 'require', '__dirname'],
    },
  }
);
