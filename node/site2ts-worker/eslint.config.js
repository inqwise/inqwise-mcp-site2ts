// ESLint v9 flat config
import tseslint from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import importPlugin from 'eslint-plugin-import';

export default [
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['dist/**'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: './tsconfig.json',
        sourceType: 'module',
        ecmaVersion: 'latest',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
      import: importPlugin,
    },
    rules: {
      'no-console': 'off',
      'no-empty': ['warn', { allowEmptyCatch: true }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
    settings: {
      'import/resolver': {
        node: { extensions: ['.js', '.mjs', '.ts'] },
      },
    },
  },
];

