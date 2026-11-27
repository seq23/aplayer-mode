// The free web preview walks the store reviewer's sign-in (tap-through.json "review-sign-in"):
// in the preview, the review address gets the review-code box exactly as in a store build, and
// every other address keeps the 6-digit box. The real session provider, the real API client and
// the real sample server run here; only native modules and the browser store are stand-ins.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const dir = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const mockModules = {
  'react-native': "export const Platform = { OS: 'web' };",
  'expo-crypto': 'export const digestStringAsync = async () => "";',
  'expo-linking': 'export const createURL = () => "";',
  'expo-web-browser': 'export const maybeCompleteAuthSession = () => {};',
  'expo-apple-authentication': 'export const signInAsync = async () => { throw new Error("no Apple sheet in the preview"); }; export const AppleAuthenticationScope = {};',
  'auth/supabase': 'export const getSupabaseClient = () => { throw new Error("no Supabase in the preview"); }; export const isSupabaseConfigured = () => false;',
  'billing/purchases': 'export const forgetBillingUser = async () => {}; export const identifyBillingUser = async () => {};',
  'integrations/push': 'export const disableApmPushForSignOut = async () => {};',
  'integrations/authStart': 'export const authStartUrl = () => ""; export const openAuthSheet = async () => ({ type: "cancel" });',
  'intake/storage': 'const m = new Map(); export const readSync = (k) => m.get(k) ?? null; export const writeSync = (k, v) => { m.set(k, v); }; export const removeSync = (k) => { m.delete(k); };',
  'preview/flag': "export const PREVIEW = true; export const PREVIEW_COPY = {};",
};
const bundle = await build({
  stdin: { contents: "export { SessionProvider, useSession } from './src/state/session';", resolveDir: dir, loader: 'ts' },
  platform: 'node', format: 'cjs', jsx: 'automatic', bundle: true, write: false, logLevel: 'error',
  external: ['react', 'react/jsx-runtime'],
  plugins: [{
    name: 'native-boundaries',
    setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, ({ path }) => {
        const key = Object.keys(mockModules).find((entry) => path === entry || path.endsWith('/' + entry));
        if (key) return { path: key, namespace: 'preview-review' };
      });
      plugin.onLoad({ filter: /.*/, namespace: 'preview-review' }, ({ path }) => ({ contents: mockModules[path] }));
    },
  }],
});
const module = { exports: {} };
new Function('module', 'exports', 'require', bundle.outputFiles[0].text)(module, module.exports, require);
const { SessionProvider, useSession } = module.exports;

function session() {
  let value;
  const Probe = () => { value = useSession(); return null; };
  renderToStaticMarkup(createElement(SessionProvider, null, createElement(Probe)));
  return value;
}

test('preview: the review address gets the review-code box, in any case and with stray spaces', async () => {
  for (const email of ['appreview@aplayermode.com', '  AppReview@APlayerMode.com ']) {
    assert.deepEqual(await session().sendEmailCode(email), { review: true }, email);
  }
});

test('preview: every other address keeps the 6-digit email box', async () => {
  for (const email of ['test-tapthrough@example.com', 'appreview@aplayermode.co', 'xappreview@aplayermode.com', '']) {
    assert.deepEqual(await session().sendEmailCode(email), { review: false }, email);
  }
});

test('preview: the review sign-in ends signed in to the sample account', async () => {
  const result = await session().verifyEmailCode('appreview@aplayermode.com', 'q7Rt2Wx9Lm4Np8Zs', 'Riley');
  assert.equal(result.outcome, 'signed_in');
  assert.equal(result.provider, 'email');
});
