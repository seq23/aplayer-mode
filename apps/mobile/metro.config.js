// Workspace packages ship TypeScript source with NodeNext-style `./x.js` imports.
// Metro does not map those to `./x.ts`, so the app bundle failed to build at all.
// Strip `.js` and let Metro try every source extension; fall back to the literal file.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const defaultResolve = config.resolver.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = defaultResolve ?? context.resolveRequest;
  if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
    try {
      return resolve(context, moduleName.slice(0, -3), platform);
    } catch {
      // Not a TypeScript source; fall through to the literal .js file.
    }
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
