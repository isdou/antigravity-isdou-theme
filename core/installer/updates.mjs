import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const PROJECT = 'isdou/antigravity-isdou-theme';
const NAME = 'antigravity-isdou-theme';
const VERSION = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/;
export const ASSET_NAME = 'theme-update.json';
const MAX_BYTES = 2 * 1024 * 1024;
const INTERVAL = 6 * 60 * 60 * 1000;
const empty = { active: null, previous: null, skipped: null, pending: null };
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isVersion = (v) => typeof v === 'string' && VERSION.test(v);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function newer(a, b) {
  const aa = a.split('.').map(Number);
  const bb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i];
  return false;
}

export function presentationDbPath(root) {
  return path.join(root, 'updates', 'appearance.sqlite');
}

export function releasePage(version) {
  return isVersion(version) ? `https://github.com/${PROJECT}/releases/tag/v${version}` : null;
}

function developmentTree(root) {
  return fs.existsSync(path.join(root, '.git')) || ['core', 'core/runtime', 'core/styles'].some(rel =>
    fs.lstatSync(path.join(root, rel), { throwIfNoEntry: false })?.isSymbolicLink());
}

function stateDb(root, write) {
  const file = presentationDbPath(root);
  if (!write && !fs.existsSync(file)) return null;
  if (write) fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(file, { readOnly: !write });
  try {
    db.exec('PRAGMA busy_timeout=3000');
    if (write) db.exec(`CREATE TABLE IF NOT EXISTS presentation (
      id INTEGER PRIMARY KEY CHECK (id=1), active TEXT, previous TEXT, skipped TEXT, pending TEXT,
      next_check INTEGER NOT NULL DEFAULT 0
    ); INSERT OR IGNORE INTO presentation(id) VALUES(1)`);
    return db;
  } catch (err) { db.close(); throw err; }
}

function stateOf(db) {
  const row = db?.prepare('SELECT active, previous, skipped, pending FROM presentation WHERE id=1').get();
  if (!row) return { ...empty };
  return { ...row, active: JSON.parse(row.active), previous: JSON.parse(row.previous) };
}

function readState(root) {
  const db = stateDb(root, false);
  try { return stateOf(db); } finally { db?.close(); }
}

function transaction(root, operation) {
  const db = stateDb(root, true);
  try {
    db.exec('BEGIN IMMEDIATE');
    const result = operation(db);
    db.exec('COMMIT');
    return result;
  } finally { db.close(); } // Closing rolls back an unfinished transaction.
}

function localProgram(root) {
  const m = JSON.parse(fs.readFileSync(path.join(root, 'core', 'manifest.json'), 'utf8'));
  if (m.name !== NAME || !isVersion(m.version) || !/^[a-f0-9]{64}$/.test(m.programHash)) {
    throw new Error('请先安装一次支持更新的完整发行包。');
  }
  return m;
}

function validatePayload(p) {
  if (!isObject(p) || Object.keys(p).some(k => !['schema', 'name', 'version', 'programHash', 'styles', 'i18n'].includes(k)) ||
      p.schema !== 1 || p.name !== NAME || !isVersion(p.version) || typeof p.programHash !== 'string' || !/^[a-f0-9]{64}$/.test(p.programHash) ||
      !isObject(p.styles) || !isObject(p.i18n)) throw new Error('无效的外观更新包。');
  const sheets = Object.entries(p.styles);
  if (!sheets.length || sheets.length > 64 || !Object.hasOwn(p.styles, '00-tokens.css')) throw new Error('样式清单无效。');
  for (const [name, css] of sheets) {
    if (!/^\d{2}-[a-z0-9-]+\.css$/.test(name) || typeof css !== 'string') throw new Error('无效的样式文件。');
    const decoded = css.replace(/\\(?:\r\n|[\n\r\f])/g, '').replace(/\\([0-9a-f]{1,6})\s?|\\(.)/gis,
      (_, hex, char) => hex ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff)) : char);
    if (/@import|(?:url|src|(?:-webkit-)?image-set|image|paint|expression)\s*\(/i.test(decoded)) {
      throw new Error('外观包只支持自包含样式。');
    }
  }
  for (const [k, v] of Object.entries(p.i18n)) {
    if (!k || ['__proto__', 'prototype', 'constructor'].includes(k) || typeof v !== 'string') throw new Error('无效的翻译条目。');
  }
  return p;
}

export function writePresentationAsset(root, manifest, outputDir) {
  const styles = {};
  for (const rel of Object.keys(manifest.files).filter(p => /^styles\/[^/]+\.css$/.test(p)).sort()) {
    styles[path.basename(rel)] = fs.readFileSync(path.join(root, 'core', rel), 'utf8');
  }
  const i18n = JSON.parse(fs.readFileSync(path.join(root, 'core', 'i18n.json'), 'utf8'));
  const payload = validatePayload({ schema: 1, name: NAME, version: manifest.version, programHash: manifest.programHash, styles, i18n });
  const bytes = JSON.stringify(payload);
  if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error('外观更新包超过 2 MiB。');
  const file = path.join(outputDir, ASSET_NAME);
  fs.writeFileSync(file, bytes);
  return file;
}

function compatible(bundle, program) {
  return bundle && bundle.programHash === program.programHash && isVersion(bundle.version) && newer(bundle.version, program.version);
}

export function readPresentation(root, program) {
  if (!program?.programHash || !fs.existsSync(presentationDbPath(root)) || developmentTree(root)) return { bundle: null, pending: null };
  try {
    const state = readState(root);
    const bundle = compatible(state.active, program) ? validatePayload(state.active) : null;
    const pending = isVersion(state.pending) && newer(state.pending, bundle?.version || program.version) ? state.pending : null;
    return { bundle, pending };
  } catch { return { bundle: null, pending: null }; }
}

async function readBytes(response, limit) {
  if (!response.ok || !response.body) throw new Error(`更新源返回 HTTP ${response.status}`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('更新响应超过大小限制。');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

function updateResult(status, version) {
  return { status, version, release: releasePage(version) };
}

export async function checkPresentation(root, { checkOnly = false, automatic = false, request = fetch } = {}) {
  if (!checkOnly && developmentTree(root)) return { status: 'development' };
  const program = localProgram(root);
  const configFile = path.join(root, 'user', 'config.json');
  const subscribed = () => {
    const config = JSON.parse(fs.readFileSync(configFile, 'utf8').replace(/^\uFEFF/, ''));
    return config.autoUpdate === true && config.enabled !== false;
  };
  if (automatic) {
    if (!subscribed()) return { status: 'disabled' };
    const now = Date.now();
    const reserved = transaction(root, db => db.prepare('UPDATE presentation SET next_check=? WHERE id=1 AND next_check<=?')
      .run(now + INTERVAL, now).changes > 0);
    if (!reserved) return { status: 'scheduled' };
  }
  const opts = { signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': NAME } };
  const res = await request(`https://api.github.com/repos/${PROJECT}/releases/latest`, opts);
  if (res.status === 404) { await res.body?.cancel(); return { status: 'no-release' }; }
  const release = JSON.parse((await readBytes(res, 256 * 1024)).toString('utf8'));
  const version = typeof release.tag_name === 'string' && release.tag_name.startsWith('v') ? release.tag_name.slice(1) : '';
  if (!isVersion(version) || release.draft || release.prerelease) throw new Error('更新源没有提供有效的正式版本。');
  const current = readPresentation(root, program).bundle?.version || program.version;
  if (!newer(version, current)) return updateResult('current', current);
  const state = readState(root);
  if (automatic && isVersion(state.skipped) && !newer(version, state.skipped)) return updateResult('skipped', version);
  if (automatic && state.pending === version) return updateResult('requires-install', version);
  const asset = release.assets?.find(a => a.name === ASSET_NAME && a.state === 'uploaded');
  let payload = null;
  if (asset) {
    if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest) || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_BYTES) {
      throw new Error('外观资源校验信息无效。');
    }
    const response = await request(`https://github.com/${PROJECT}/releases/download/v${version}/${ASSET_NAME}`, opts);
    const bytes = await readBytes(response, MAX_BYTES);
    if (bytes.length !== asset.size || 'sha256:' + sha256(bytes) !== asset.digest) throw new Error('外观包摘要或大小不匹配。');
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (parsed?.version !== version) throw new Error('更新包与发布标签版本不一致。');
    if (!(Number.isSafeInteger(parsed.schema) && parsed.schema > 1)) {
      validatePayload(parsed);
      if (parsed.programHash === program.programHash) payload = parsed;
    }
  }
  if (checkOnly) return updateResult(payload ? 'available' : 'requires-install', version);
  if (automatic && !subscribed()) return { status: 'disabled' };
  return transaction(root, db => {
    const fresh = stateOf(db);
    const installed = localProgram(root);
    if (installed.programHash !== program.programHash || installed.version !== program.version) return { status: 'install-changed' };
    const effective = compatible(fresh.active, installed) ? fresh.active.version : installed.version;
    if (!newer(version, effective)) return updateResult('current', effective);
    if (automatic && isVersion(fresh.skipped) && !newer(version, fresh.skipped)) return updateResult('skipped', version);
    if (isVersion(fresh.pending) && newer(fresh.pending, version)) return updateResult('requires-install', fresh.pending);
    if (!payload) {
      db.prepare('UPDATE presentation SET pending=? WHERE id=1').run(version);
      return updateResult('requires-install', version);
    }
    db.prepare('UPDATE presentation SET previous=active, active=?, pending=NULL, skipped=NULL WHERE id=1').run(JSON.stringify(payload));
    return updateResult('applied', version);
  });
}

export function rollbackPresentation(root) {
  const program = localProgram(root);
  if (developmentTree(root) || !fs.existsSync(presentationDbPath(root))) return updateResult('current', program.version);
  return transaction(root, db => {
    const state = stateOf(db);
    if (!compatible(state.active, program)) return updateResult('current', program.version);
    const previous = compatible(state.previous, program) ? state.previous : null;
    const skipThrough = isVersion(state.skipped) && newer(state.skipped, state.active.version) ? state.skipped : state.active.version;
    db.prepare('UPDATE presentation SET active=?, previous=NULL, skipped=? WHERE id=1')
      .run(previous ? JSON.stringify(previous) : null, skipThrough);
    return updateResult('rolled-back', previous?.version || program.version);
  });
}

export function startPresentationChecks(root) {
  const tick = () => checkPresentation(root, { automatic: true }).then(result => {
    if (['applied', 'requires-install'].includes(result.status)) console.log('[Theme update]', result.status, result.version, result.release);
  }).catch(err => console.warn('[Theme update]', err.message));
  const first = setTimeout(tick, 15_000);
  const timer = setInterval(tick, INTERVAL);
  first.unref();
  timer.unref();
}
