/* ESLint config for ground/ui (`npm run lint` = eslint . --ext .ts,.tsx).
 * Note: no config existed before the mission retrofit — lint failed with
 * "couldn't find a configuration file". This matches the Vite React+TS
 * template the app was built from, with unused-vars relaxed to mirror the
 * tsconfig convention (noUnusedLocals/noUnusedParameters: false). */
module.exports = {
  root: true,
  env: { browser: true, es2021: true },
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended',
    'plugin:react-hooks/recommended',
  ],
  ignorePatterns: ['dist', 'node_modules', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  plugins: ['react-refresh'],
  rules: {
    'react-refresh/only-export-components': 'off',
    // tsconfig has noUnusedLocals/noUnusedParameters: false — keep lint aligned.
    '@typescript-eslint/no-unused-vars': 'off',
    // Inline SVG/canvas drawing code uses intentional non-null assertions.
    '@typescript-eslint/no-non-null-assertion': 'off',
  },
};
