// @ts-check
import eslint from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettierConfig from 'eslint-config-prettier'

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      'node_modules/**',
      'coverage/**',
      // The flat config is plain JS with @ts-check; it is not part of
      // the type-checked project.
      'eslint.config.mjs',
      // The ncc build output and lockfile are machine-generated.
      'package-lock.json'
    ]
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      // Actions run in a workflow step: a top-level await-free CJS entry is
      // the norm, and the async run() wrapper handles process-level failure.
      'no-console': 'error',
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/explicit-function-return-type': [
        'error',
        { allowExpressions: true }
      ],
      '@typescript-eslint/consistent-type-imports': 'error',
      // Numbers interpolate unambiguously; only nullish/any are dangerous.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true }
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }
      ],
      // The protocol client legitimately narrows JSON payloads.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-base-to-string': 'off'
    }
  },
  {
    files: ['test/**/*.ts', 'vitest.config.ts', 'eslint.config.mjs'],
    rules: {
      'no-console': 'off',
      // Tests assert on fake-server state directly; non-null assertions
      // and number interpolation are idiomatic there.
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/restrict-template-expressions': 'off',
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-dynamic-delete': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'off',
      '@typescript-eslint/no-unused-expressions': 'off'
    }
  },
  prettierConfig
)
