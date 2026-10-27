import js from '@eslint/js';
import tseslint from 'typescript-eslint';
export default [
  { ignores: ['**/node_modules/**', '**/dist/**'] },
  {
    files: ['**/*.mjs', '**/*.ts', '**/*.tsx'],
    languageOptions: { parser: tseslint.parser, ecmaVersion: 'latest', sourceType: 'module' },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {
      'no-duplicate-imports': ['error', { allowSeparateTypeImports: true }],
      'no-unreachable': js.configs.recommended.rules['no-unreachable'],
      'constructor-super': 'error',
      'valid-typeof': 'error'
    }
  }
];
