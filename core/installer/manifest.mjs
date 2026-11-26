/**
 * core/installer/manifest.mjs — Recursive SHA-256 Manifest Builder, Verifier & Dist Packager
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { writePresentationAsset, ASSET_NAME } from './updates.mjs';

export function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function walkRelativeCoreFiles(coreDir, subDir = '', out = []) {
  const fullDir = subDir ? path.join(coreDir, subDir) : coreDir;
  for (const entry of fs.readdirSync(fullDir, { withFileTypes: true })) {
    if (entry.name === '.DS_Store') continue;
    if (!subDir && entry.name === 'manifest.json') continue;
    const rel = subDir ? `${subDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walkRelativeCoreFiles(coreDir, rel, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

function readPackageMeta(baseDir) {
  try {
    const pkgPath = path.join(baseDir, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      return {
        name: pkg.name || 'antigravity-codex-theme',
        version: pkg.version || '1.0.0'
      };
    }
  } catch {}
  return { name: 'antigravity-codex-theme', version: '1.0.0' };
}

export function buildManifest(baseDir, sourceProgramHash = null) {
  const coreDir = path.join(baseDir, 'core');
  if (!fs.existsSync(coreDir)) {
    throw new Error(`Missing core directory: ${coreDir}`);
  }
  const relFiles = walkRelativeCoreFiles(coreDir).sort((a, b) => a.localeCompare(b));
  const entries = {};
  for (const rel of relFiles) {
    const p = path.join(coreDir, rel);
    const stat = fs.statSync(p);
    entries[rel] = {
      sha256: sha256File(p),
      bytes: stat.size
    };
  }
  const meta = readPackageMeta(baseDir);
  const programFiles = ['install.mjs', ...Object.keys(entries)
    .filter(rel => !rel.startsWith('styles/') && rel !== 'i18n.json')
    .map(rel => 'core/' + rel)].sort();
  const program = crypto.createHash('sha256');
  for (const file of programFiles) {
    const source = fs.readFileSync(path.join(baseDir, file), 'utf8').replace(/\r\n/g, '\n');
    program.update(file + '\0' + crypto.createHash('sha256').update(source).digest('hex') + '\n');
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(baseDir, 'package.json'), 'utf8'));
  program.update(JSON.stringify([pkg.engines, pkg.dependencies, pkg.optionalDependencies]));
  const localHash = program.digest('hex');
  const manifestPath = path.join(coreDir, 'manifest.json');
  if (!sourceProgramHash && fs.existsSync(manifestPath)) {
    let previous;
    try { previous = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}
    if (previous?.partial && previous.localProgramHash === localHash) sourceProgramHash = previous.programHash;
  }
  const manifest = {
    name: meta.name,
    version: meta.version,
    programHash: sourceProgramHash || localHash,
    ...(sourceProgramHash ? { partial: true, localProgramHash: localHash } : {}),
    minNodeVersion: '22.13.0',
    fullMetricsNodeVersion: '22.13.0',
    files: entries
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return manifest;
}

export function verifyCoreIntegrity(baseDir) {
  const coreDir = path.join(baseDir, 'core');
  const manifestPath = path.join(coreDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, reason: 'missing manifest.json', modified: [] };
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const modified = [];
  const expectedFiles = manifest.files || {};

  for (const [rel, meta] of Object.entries(expectedFiles)) {
    const p = path.join(coreDir, rel);
    if (!fs.existsSync(p)) {
      modified.push({ file: rel, status: 'missing' });
      continue;
    }
    let actualHash = sha256File(p);
    if (actualHash !== meta.sha256) {
      try {
        const rawText = fs.readFileSync(p, 'utf8');
        if (rawText.includes('\r\n')) {
          const lfText = rawText.replace(/\r\n/g, '\n');
          const lfHash = crypto.createHash('sha256').update(Buffer.from(lfText, 'utf8')).digest('hex');
          if (lfHash === meta.sha256) {
            fs.writeFileSync(p, lfText, 'utf8');
            actualHash = lfHash;
          }
        }
      } catch {}
    }
    if (actualHash !== meta.sha256) {
      modified.push({ file: rel, status: 'modified', expected: meta.sha256, actual: actualHash });
    }
  }

  for (const rel of walkRelativeCoreFiles(coreDir)) {
    if (!Object.prototype.hasOwnProperty.call(expectedFiles, rel)) {
      modified.push({ file: rel, status: 'untracked' });
    }
  }

  return { ok: modified.length === 0, manifest, modified };
}

export function buildDistZip(baseDir) {
  if (!fs.existsSync(path.join(baseDir, 'distribution', 'README.md'))) {
    throw new Error('请在完整的项目源码目录制作发行包。');
  }
  const manifest = buildManifest(baseDir);
  const distDir = path.join(baseDir, 'dist');
  fs.mkdirSync(distDir, { recursive: true });
  const zipName = `${manifest.name}-v${manifest.version}.zip`;
  const zipPath = path.join(distDir, zipName);
  const work = fs.mkdtempSync(path.join(distDir, '.pack-'));
  const src = path.join(work, 'package');
  const tempZip = path.join(work, zipName);
  try {
    fs.mkdirSync(src);
    const copy = (from, to = from) => {
      const dest = path.join(src, to);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(baseDir, from), dest);
    };
    for (const rel of Object.keys(manifest.files)) copy('core/' + rel);
    for (const file of ['package.json', 'install.mjs', 'LICENSE']) copy(file);
    for (const file of ['config.json', 'custom.css', 'custom.js', 'i18n.override.json']) {
      if (fs.existsSync(path.join(baseDir, 'user', file))) copy('user/' + file);
    }
    copy('distribution/README.md', 'README.md');
    for (const optional of ['SKILL.md', 'assets']) {
      if (fs.existsSync(path.join(baseDir, optional))) fs.cpSync(path.join(baseDir, optional), path.join(src, optional), { recursive: true });
    }
    if (JSON.stringify(buildManifest(src)) !== JSON.stringify(manifest)) throw new Error('打包期间源码发生变化，请重试。');
    writePresentationAsset(src, manifest, work);
    const include = fs.readdirSync(src);
    if (process.platform === 'win32') {
      const escaped = tempZip.replace(/'/g, "''");
      const command = `Compress-Archive -LiteralPath ${include.map(name => "'" + name + "'").join(',')} -DestinationPath '${escaped}' -Force`;
      if (spawnSync('powershell', ['-NoProfile', '-Command', command], { cwd: src, stdio: 'inherit', windowsHide: true }).status !== 0) {
        throw new Error('Compress-Archive failed');
      }
    } else {
      if (spawnSync('zip', ['-r', '-q', tempZip, ...include, '-x', '*.DS_Store'], { cwd: src, stdio: 'inherit' }).status !== 0) {
        throw new Error('zip command failed');
      }
      for (const [name, meta] of Object.entries(manifest.files)) {
        const entry = spawnSync('unzip', ['-p', tempZip, 'core/' + name], { maxBuffer: 20 * 1024 * 1024 });
        if (entry.status !== 0 || entry.stdout.length !== meta.bytes || crypto.createHash('sha256').update(entry.stdout).digest('hex') !== meta.sha256) {
          throw new Error('Archive verification failed: core/' + name);
        }
      }
    }
    const assetPath = path.join(distDir, ASSET_NAME);
    fs.renameSync(tempZip, zipPath);
    fs.renameSync(path.join(work, ASSET_NAME), assetPath);
    return { zipPath, assetPath, version: manifest.version, filesVerified: Object.keys(manifest.files).length };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}
