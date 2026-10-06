module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'script',
  },
  ignorePatterns: [
    'node_modules/',
    'coverage/',
  ],
  extends: ['eslint:recommended'],
  rules: {
    'no-unused-vars': 'off',
    'no-constant-condition': ['error', { checkLoops: false }],
    'no-debugger': 'error',
  },
  overrides: [
    {
      files: ['**/*.mjs'],
      parserOptions: {
        sourceType: 'module',
      },
    },
  ],
};
