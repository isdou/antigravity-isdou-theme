import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildManifest } from '../core/installer/manifest.mjs';
import { ASSET_NAME, checkPresentation, readPresentation, rollbackPresentation, writePresentationAsset } from '../core/installer/updates.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));

function installation(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appearance-install-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const entry of ['core', 'user', 'package.json', 'install.mjs']) {
    fs.cpSync(path.join(repo, entry), path.join(dir, entry), { recursive: true });
  }
  const config = path.join(dir, 'user/config.json');
  fs.writeFileSync(config, JSON.stringify({ enabled: true, autoUpdate: true }));
  const manifest = buildManifest(dir);
  const asset = writePresentationAsset(dir, manifest, dir);
  const base = JSON.parse(fs.readFileSync(asset, 'utf8'));
  // Reserve several future patch versions regardless of the publishing version.
  const [major, minor] = base.version.split('.');
  const next = patch => `${major}.${Number(minor) + 1}.${patch}`;
  return { dir, manifest, base, config, next };
}

function release(payload, metadata = {}) {
  const bytes = Buffer.from(JSON.stringify(payload));
  const asset = { name: ASSET_NAME, state: 'uploaded', size: bytes.length,
    digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex'), ...metadata };
  const urls = [];
  const request = async url => {
    urls.push(url);
    if (url === 'https://api.github.com/repos/isdou/antigravity-isdou-theme/releases/latest') {
      return Response.json({ tag_name: 'v' + payload.version, draft: false, prerelease: false, assets: [asset] });
    }
    assert.equal(url, `https://github.com/isdou/antigravity-isdou-theme/releases/download/v${payload.version}/theme-update.json`);
    return new Response(bytes);
  };
  return { request, urls };
}

test('a separate installation hot reloads style and translations, preserves overrides and rolls back', async t => {
  const { dir, manifest, base, next, config } = installation(t);
  const overrides = path.join(dir, 'user/i18n.override.json');
  fs.writeFileSync(overrides, JSON.stringify({ 'Theme Test': '个人译文' }));
  fs.writeFileSync(path.join(dir, 'user/custom.css'), ':root { --user-test: retained; }');
  const localBefore = ['core/manifest.json', 'core/styles/00-tokens.css', 'user/config.json', 'user/custom.css', 'user/i18n.override.json']
    .map(file => [file, fs.readFileSync(path.join(dir, file))]);
  const { createBundleController } = await import(pathToFileURL(path.join(dir, 'core/daemon/paths.mjs')));
  const loader = createBundleController();
  loader.rebuildBundleIfNeeded();
  const initial = loader.getState().cachedPatchVersion;
  const payload = { ...base, version: next(1), styles: { ...base.styles, '00-tokens.css': ':root { --release-test: first; }', '35-reading.css': ':root { --new-sheet: active; }' },
    i18n: { ...base.i18n, 'Theme Test': '发行版译文', 'New Theme Test': '新的译文' } };
  const r = release(payload);
  assert.equal((await checkPresentation(dir, { checkOnly: true, request: r.request })).status, 'available');
  assert.equal(fs.existsSync(path.join(dir, 'updates')), false);
  assert.equal((await checkPresentation(dir, r)).status, 'applied');
  assert.equal(loader.rebuildBundleIfNeeded(), true);
  const current = loader.getState();
  assert.notEqual(current.cachedPatchVersion, initial);
  for (const s of ['--release-test: first', '--new-sheet: active', '--user-test: retained', '个人译文', '新的译文']) assert.ok(current.cachedInjectScript.includes(s));
  assert.ok(!current.cachedInjectScript.includes('发行版译文'));
  const safe = createBundleController({ safeMode: true });
  safe.rebuildBundleIfNeeded();
  assert.ok(!safe.getState().cachedInjectScript.includes('--release-test: first'));
  for (const [file, bytes] of localBefore) assert.deepEqual(fs.readFileSync(path.join(dir, file)), bytes);
  assert.equal((await checkPresentation(dir, release({ ...payload, version: next(2) }))).status, 'applied');
  assert.equal(rollbackPresentation(dir).version, next(1));
  assert.equal((await checkPresentation(dir, { automatic: true, ...release({ ...payload, version: next(2) }) })).status, 'skipped');
  assert.equal(readPresentation(dir, manifest).bundle.version, next(1));
  assert.equal(rollbackPresentation(dir).version, manifest.version);
  loader.rebuildBundleIfNeeded();
  assert.equal(loader.getState().cachedPatchVersion, initial);
  assert.ok(fs.existsSync(config));
});

test('bad artifacts never replace a working version and program changes provide a fixed download page', async t => {
  const { dir, manifest, base, next } = installation(t);
  const good = { ...base, version: next(1) };
  await checkPresentation(dir, release(good));
  const nextPayload = { ...base, version: next(2) };
  await assert.rejects(checkPresentation(dir, release(nextPayload, { digest: 'sha256:' + 'f'.repeat(64) })), /不匹配/);
  await assert.rejects(checkPresentation(dir, release({ ...nextPayload, runtime: 'invalid' })), /无效/);
  await assert.rejects(checkPresentation(dir, release({ ...nextPayload, styles: { '00-tokens.css': '@import "external.css";' } })), /自包含/);
  const badVersion = { ...nextPayload, programHash: 'f'.repeat(64) };
  const status = await checkPresentation(dir, release(badVersion));
  assert.equal(status.status, 'requires-install');
  assert.equal(status.release, 'https://github.com/isdou/antigravity-isdou-theme/releases/tag/v' + badVersion.version);
  assert.equal(readPresentation(dir, manifest).pending, badVersion.version);
  assert.equal(readPresentation(dir, manifest).bundle.version, good.version);
  const { createBundleController } = await import(pathToFileURL(path.join(dir, 'core/daemon/paths.mjs')));
  const loader = createBundleController();
  loader.rebuildBundleIfNeeded();
  assert.ok(loader.getState().cachedInjectScript.includes('"updateNotice":{"version":"' + badVersion.version + '"'));
});

test('checks have a persistent schedule, require opt-in, and tolerate an empty release channel', async t => {
  const { dir, config } = installation(t);
  let calls = 0;
  const request = async () => { calls++; return new Response(null, { status: 404 }); };
  const [a, b] = await Promise.all([checkPresentation(dir, { automatic: true, request }), checkPresentation(dir, { automatic: true, request })]);
  assert.deepEqual([a.status, b.status].sort(), ['no-release', 'scheduled']);
  assert.equal((await checkPresentation(dir, { automatic: true, request })).status, 'scheduled');
  assert.equal(calls, 1);
  fs.writeFileSync(config, JSON.stringify({ autoUpdate: false }));
  assert.equal((await checkPresentation(dir, { automatic: true, request })).status, 'disabled');
  assert.equal(calls, 1);
  fs.mkdirSync(path.join(dir, '.git'));
  assert.equal((await checkPresentation(dir, { automatic: true, request })).status, 'development');
});

test('version changes and styling can hot reload, while program changes require a new installer', t => {
  const { dir, manifest, next } = installation(t);
  const pkg = path.join(dir, 'package.json');
  const info = JSON.parse(fs.readFileSync(pkg, 'utf8'));
  fs.writeFileSync(pkg, JSON.stringify({ ...info, version: next(1) }));
  fs.appendFileSync(path.join(dir, 'core/styles/20-chat.css'), '\n:root {}\n');
  assert.equal(buildManifest(dir).programHash, manifest.programHash);
  fs.appendFileSync(path.join(dir, 'core/runtime/20-theme-sync.js'), '\nvoid 0;\n');
  assert.notEqual(buildManifest(dir).programHash, manifest.programHash);
});

test('selective installs keep missing modules and files excluded when consuming a full appearance package', async t => {
  const { dir, manifest, base, next } = installation(t);
  fs.rmSync(path.join(dir, 'core/runtime/60-i18n-engine.js'));
  fs.rmSync(path.join(dir, 'core/styles/15-topbar.css'));
  fs.rmSync(path.join(dir, 'core/i18n.json'));
  const sparse = buildManifest(dir, manifest.programHash);
  assert.equal(buildManifest(dir).programHash, manifest.programHash);
  const payload = { ...base, version: next(1), styles: { ...base.styles, '15-topbar.css': ':root{--omitted-test:1}' }, i18n: { OmittedTest: 'omitted-marker' } };
  await checkPresentation(dir, release(payload));
  const { createBundleController } = await import(pathToFileURL(path.join(dir, 'core/daemon/paths.mjs')));
  const loader = createBundleController();
  loader.rebuildBundleIfNeeded();
  assert.equal(sparse.programHash, base.programHash);
  assert.ok(!loader.getState().cachedInjectScript.includes('--omitted-test'));
  assert.ok(!loader.getState().cachedInjectScript.includes('omitted-marker'));
});

test('an older concurrent download cannot supersede a newer committed update', async t => {
  const { dir, manifest, base, next } = installation(t);
  const older = release({ ...base, version: next(1) });
  let begin, resume;
  const downloading = new Promise(resolve => { begin = resolve; });
  const pause = new Promise(resolve => { resume = resolve; });
  const delayed = checkPresentation(dir, { request: async url => {
    if (url.includes('/download/')) { begin(); await pause; }
    return older.request(url);
  } });
  await downloading;
  await checkPresentation(dir, release({ ...base, version: next(2) }));
  resume();
  assert.equal((await delayed).version, next(2));
  assert.equal(readPresentation(dir, manifest).bundle.version, next(2));
});

test('network failure uses the existing appearance and does not start a retry loop', async t => {
  const { dir, manifest, base, next } = installation(t);
  await checkPresentation(dir, release({ ...base, version: next(1) }));
  let tries = 0;
  const request = async () => { tries++; throw new Error('offline'); };
  await assert.rejects(checkPresentation(dir, { automatic: true, request }), /offline/);
  assert.equal((await checkPresentation(dir, { automatic: true, request })).status, 'scheduled');
  assert.equal(tries, 1);
  assert.equal(readPresentation(dir, manifest).bundle.version, next(1));
});
