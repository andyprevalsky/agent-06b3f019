import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'node_modules'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2022,
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'error',
      'max-lines': ['error', { max: 600, skipBlankLines: true, skipComments: true }],
      'no-console': 'error',
      eqeqeq: ['error', 'always'],
      'no-duplicate-imports': 'error',
      'prefer-const': 'error',
    },
  },
  {
    files: ['**/*.{js,jsx,mjs,cjs}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Program',
          message: 'JavaScript files are not allowed in src/. Use TypeScript (.ts/.tsx) instead.',
        },
      ],
    },
  }
);
