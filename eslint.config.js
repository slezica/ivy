// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');
const ivyPlugin = require('./eslint');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: ['dist/*'],
  },
  {
    plugins: {
      ivy: ivyPlugin,
    },
    rules: {
      'ivy/align-ternary-chain': 'error',
      'ivy/align-ternary-single': 'error',
      'ivy/jsx-newline-around-multiline': 'warn',
    },
  },
]);
