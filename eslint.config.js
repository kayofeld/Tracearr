import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  prettierConfig,
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/.turbo/**',
      '**/coverage/**',
      'apps/mobile/plugins/**',
      'apps/mobile/.expo/**',
      'apps/mobile/**.config.js',
      'apps/mobile/**.config.mjs',
    ],
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
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-invalid-void-type': 'off',
      // Transitional: warn on @deprecated usage during multi-server migration
      '@typescript-eslint/no-deprecated': 'warn',
    },
  },
  {
    files: ['**/*.tsx', '**/*.jsx'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
    },
    settings: {
      react: {
        version: 'detect',
      },
    },
    rules: {
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react/no-unescaped-entities': 'off',
      'react-hooks/set-state-in-effect': 'off',
      // Disable React Compiler rules (new in v7) until codebase is ready
      'react-hooks/react-compiler': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/static-components': 'off',
      'react-hooks/purity': 'off',
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
  }
);
