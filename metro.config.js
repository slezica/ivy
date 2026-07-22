const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Add wasm support for expo-sqlite web
config.resolver.assetExts.push('wasm');

// Don't crawl git worktrees (worktrees/, plus legacy root worktreeN/) — they
// are full checkouts with their own node_modules
config.resolver.blockList = [
  ...(Array.isArray(config.resolver.blockList) ? config.resolver.blockList : [config.resolver.blockList]),
  /[/\\]worktree[^/\\]*[/\\]/,
].filter(Boolean);

module.exports = config;
