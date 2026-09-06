#!/usr/bin/env node
/**
 * selfcheck.cjs — behavioural tests for the shell's main-process modules.
 *
 * The shell has no test runner and its modules import 'electron', which only
 * exists inside a running Electron. This script substitutes a minimal fake
 * `electron` in Node's module cache and exercises the COMPILED modules in
 * dist-electron/ against a throw-away temp directory, so it checks exactly
 * what ships.
 *
 *   npm run build:electron && node scripts/selfcheck.cjs
 *
 * Exit status is non-zero on any failure (node:test). Nothing in the repo is
 * touched: settings and recordings go to a fresh directory under os.tmpdir().
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { test, describe, after } = require('node:test');

/* ── Fake electron ──────────────────────────────────────────────────────── */

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'eis-shell-selfcheck-'));
const userData = path.join(scratch, 'userData');
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

const powerLog = [];
const fakeElectron = {
  app: {
    getPath: (name) => (name === 'userData' ? userData : scratch),
    getVersion: () => '0.0.0-selfcheck',
    isPackaged: false,
    once() {},
    on() {},
    requestSingleInstanceLock: () => true,
    whenReady: () => new Promise(() => undefined),
    quit() {},
  },
  ipcMain: { handle() {}, on() {} },
  BrowserWindow: { getAllWindows: () => [] },
  Menu: { buildFromTemplate: (t) => t, setApplicationMenu() {} },
  shell: { openExternal: () => Promise.resolve() },
  powerSaveBlocker: {
    _next: 1,
    _live: new Set(),
    start(kind) { const id = this._next++; this._live.add(id); powerLog.push(['start', kind, id]); return id; },
    stop(id) { this._live.delete(id); powerLog.push(['stop', id]); },
    isStarted(id) { return this._live.has(id); },
  },
};

const electronId = require.resolve('electron');
const fake = new Module(electronId, null);
fake.filename = electronId;
fake.loaded = true;
fake.exports = fakeElectron;
require.cache[electronId] = fake;

const dist = path.join(__dirname, '..', 'dist-electron');
for (const file of ['settingsStore.js', 'recorder.js', 'ipc.js']) {
  assert.ok(fs.existsSync(path.join(dist, file)), `${file} missing — run "npm run build:electron" first`);
}
const settingsMod = require(path.join(dist, 'settingsStore.js'));
const recorderMod = require(path.join(dist, 'recorder.js'));
const ipcMod = require(path.join(dist, 'ipc.js'));

const tmpFile = (name) => path.join(fs.mkdtempSync(path.join(scratch, 'case-')), name);
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf-8'); };

/* ── Settings ───────────────────────────────────────────────────────────── */

describe('settingsStore', () => {
  test('a fresh store is empty and writes the contract layout', async () => {
    const file = tmpFile('settings.json');
    const store = settingsMod.createSettingsStore(() => file);
    assert.equal(await store.get('eis.settings'), undefined);
    assert.deepEqual(await store.all(), {});
    assert.ok(!fs.existsSync(file), 'reads never create the file');

    await store.set('eis.settings', { connection: { host: 'sitl', controlPort: 8765 }, units: 'metric' });
    const onDisk = fs.readFileSync(file, 'utf-8');
    assert.equal(onDisk, JSON.stringify({ 'eis.settings': { connection: { host: 'sitl', controlPort: 8765 }, units: 'metric' } }, null, 2));
    assert.ok(!fs.existsSync(`${file}.${process.pid}.tmp`), 'temp file is renamed away');
  });

  test('a file written by the previous implementation loads unchanged', async () => {
    const file = tmpFile('settings.json');
    // Byte-for-byte what the earlier build produced: JSON.stringify(map, null, 2).
    const legacy = { 'eis.settings': { connection: { host: '10.0.0.7', controlPort: 8765, videoUrl: '', sitl: false }, pid: { yaw: { kp: 0.4 } } }, 'other.key': [1, 2, 3] };
    write(file, JSON.stringify(legacy, null, 2));
    const store = settingsMod.createSettingsStore(() => file);
    assert.deepEqual(await store.get('eis.settings'), legacy['eis.settings']);
    assert.deepEqual(await store.all(), legacy);
  });

  test('all() is a copy; set() is visible to a following get() without awaiting', async () => {
    const file = tmpFile('settings.json');
    const store = settingsMod.createSettingsStore(() => file);
    const snapshot = await store.all();
    snapshot.injected = true;
    assert.deepEqual(await store.all(), {});
    const pending = store.set('a', 1);
    const seen = store.get('a');
    await pending;
    assert.equal(await seen, 1);
  });

  test('concurrent sets serialise and the last file is complete', async () => {
    const file = tmpFile('settings.json');
    const store = settingsMod.createSettingsStore(() => file);
    await Promise.all(Array.from({ length: 12 }, (_, i) => store.set(`k${i}`, i)));
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.equal(Object.keys(parsed).length, 12);
    assert.equal(parsed.k11, 11);
  });

  test('set(key, undefined) removes the key on disk', async () => {
    const file = tmpFile('settings.json');
    const store = settingsMod.createSettingsStore(() => file);
    await store.set('gone', 1);
    await store.set('kept', 2);
    await store.set('gone', undefined);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), { kept: 2 });
    assert.equal(await store.get('gone'), undefined);
  });

  test('a corrupt file starts fresh and is quarantined, not destroyed', async () => {
    const file = tmpFile('settings.json');
    write(file, '{"eis.settings": {"connection": ');
    const store = settingsMod.createSettingsStore(() => file);
    assert.deepEqual(await store.all(), {});
    assert.equal(fs.readFileSync(`${file}.corrupt`, 'utf-8'), '{"eis.settings": {"connection": ');
    await store.set('x', 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), { x: 1 });
  });

  test('decodeSettingsDocument repairs odd roots and drops forbidden keys', () => {
    const { decodeSettingsDocument } = settingsMod;
    assert.deepEqual(decodeSettingsDocument(''), { kind: 'empty' });
    assert.deepEqual(decodeSettingsDocument('\ufeff{"a":1}'), { kind: 'loaded', entries: { a: 1 } });
    assert.equal(decodeSettingsDocument('[1,2]').kind, 'repaired');
    assert.equal(decodeSettingsDocument('null').kind, 'repaired');
    assert.equal(decodeSettingsDocument('nope').kind, 'corrupt');
    const polluted = decodeSettingsDocument('{"__proto__": {"x": 1}, "ok": true}');
    assert.equal(polluted.kind, 'repaired');
    assert.deepEqual(polluted.entries, { ok: true });
    assert.equal(Object.prototype.hasOwnProperty.call(polluted.entries, '__proto__'), false);
  });

  test('the default store lives at <userData>/settings.json', async () => {
    await settingsMod.settingsStore.set('probe', 'yes');
    assert.equal(settingsMod.settingsStore.filePath, path.join(userData, 'settings.json'));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(userData, 'settings.json'), 'utf-8')), { probe: 'yes' });
  });
});

/* ── Recorder ───────────────────────────────────────────────────────────── */

const withRecordingsDir = (dir, fn) => {
  const previous = process.env.EIS_RECORDINGS_DIR;
  process.env.EIS_RECORDINGS_DIR = dir;
  return Promise.resolve().then(fn).finally(() => {
    if (previous === undefined) delete process.env.EIS_RECORDINGS_DIR;
    else process.env.EIS_RECORDINGS_DIR = previous;
  });
};

describe('recorder', () => {
  const { RecordingCodec, createRecorder, SESSION_ID_PATTERN } = recorderMod;

  test('session ids follow yyyyMMdd-HHmmss-mmm in local time', () => {
    assert.equal(SESSION_ID_PATTERN, 'yyyyMMdd-HHmmss-SSS');
    assert.equal(RecordingCodec.sessionId(new Date(2024, 5, 22, 14, 30, 12, 1)), '20240622-143012-001');
    assert.equal(RecordingCodec.sessionId(new Date(2026, 0, 3, 4, 5, 6, 789)), '20260103-040506-789');
    assert.match(RecordingCodec.sessionId(new Date()), /^\d{8}-\d{6}-\d{3}$/);
  });

  test('a full session round-trips through the on-disk format', () => withRecordingsDir(path.join(scratch, 'rec-a'), async () => {
    const rec = createRecorder(() => path.join(userData, 'recordings'));
    const { sessionId } = await rec.start({ pilot: 'Alice', id: 'ignored', _header: false });
    assert.match(sessionId, /^\d{8}-\d{6}-\d{3}$/);
    assert.equal(rec.activeSessionId(), sessionId);

    const file = path.join(scratch, 'rec-a', `${sessionId}.ndjson`);
    assert.ok(fs.existsSync(file));
    const header = JSON.parse(fs.readFileSync(file, 'utf-8').split('\n')[0]);
    assert.equal(header._header, true);
    assert.equal(header.id, sessionId, 'reserved keys win over meta');
    assert.equal(typeof header.startedAt, 'number');
    assert.equal(header.pilot, 'Alice');

    rec.append({ type: 'telemetry', ts: 1 });
    rec.append({ type: 'tracking', ts: 2 });
    rec.append(undefined);            // no JSON form → dropped, no "undefined" line
    const stopped = await rec.stop();
    assert.deepEqual(stopped, { sessionId, path: file });
    assert.equal(rec.activeSessionId(), null);
    rec.append({ type: 'late' });     // inactive → ignored

    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    assert.equal(lines.length, 4, 'header + 2 frames + trailing newline');
    assert.deepEqual(JSON.parse(lines[1]), { type: 'telemetry', ts: 1 });

    const list = await rec.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, sessionId);
    assert.equal(list[0].path, file);
    assert.equal(list[0].startedAt, header.startedAt);
    assert.ok(list[0].durationMs >= 0);
    assert.equal(list[0].size, fs.statSync(file).size);

    const loaded = await rec.load(sessionId);
    assert.deepEqual(loaded.meta, { id: sessionId, startedAt: header.startedAt, pilot: 'Alice' });
    assert.deepEqual(loaded.frames, [{ type: 'telemetry', ts: 1 }, { type: 'tracking', ts: 2 }]);
    assert.equal(await rec.stop(), null);
  }));

  test('recordings written by the previous implementation still open', () => withRecordingsDir(path.join(scratch, 'rec-b'), async () => {
    const dir = path.join(scratch, 'rec-b');
    const legacy = [
      JSON.stringify({ _header: true, id: '20240622-143012-001', startedAt: 1719066612001, pilot: 'Bob' }),
      JSON.stringify({ type: 'telemetry', ts: 1719066612100, armed: true }),
      '{"type":"tracking", "ts": 1719066612200, torn',
      '',
      JSON.stringify({ type: 'statusText', ts: 1719066612300, text: 'ok' }),
      '',
    ].join('\n');
    write(path.join(dir, '20240622-143012-001.ndjson'), legacy);
    write(path.join(dir, 'empty.ndjson'), '');
    write(path.join(dir, 'notes.txt'), 'not a recording');

    const rec = createRecorder(() => path.join(userData, 'recordings'));
    const list = await rec.list();
    assert.deepEqual(list.map((s) => s.id), ['20240622-143012-001'], 'empty and foreign files are skipped');
    assert.equal(list[0].startedAt, 1719066612001);

    const loaded = await rec.load('20240622-143012-001');
    assert.deepEqual(loaded.meta, { id: '20240622-143012-001', startedAt: 1719066612001, pilot: 'Bob' });
    assert.equal(loaded.frames.length, 2, 'the torn line is skipped, the rest loads');
    assert.equal(loaded.frames[1].text, 'ok');
    assert.equal(await rec.load('empty'), null);
    assert.equal(await rec.load('missing'), null);
  }));

  test('a header id that differs from the file name is honoured, and ids cannot escape the directory', () => withRecordingsDir(path.join(scratch, 'rec-c'), async () => {
    const dir = path.join(scratch, 'rec-c');
    write(path.join(dir, 'renamed.ndjson'), JSON.stringify({ _header: true, id: 'flight-7', startedAt: 5 }) + '\n' + JSON.stringify({ ts: 6 }) + '\n');
    write(path.join(dir, 'headerless.ndjson'), JSON.stringify({ ts: 1 }) + '\n');
    write(path.join(scratch, 'outside.ndjson'), JSON.stringify({ _header: true, id: 'outside', startedAt: 1 }) + '\n');

    const rec = createRecorder(() => path.join(userData, 'recordings'));
    const ids = (await rec.list()).map((s) => s.id).sort();
    assert.deepEqual(ids, ['flight-7', 'headerless']);
    assert.deepEqual((await rec.load('flight-7')).frames, [{ ts: 6 }]);
    assert.equal(await rec.load('../outside'), null);
    assert.equal(await rec.load('..'), null);
    assert.equal(await rec.load(''), null);
    assert.equal(await rec.load(42), null);
  }));

  test('starting again closes the previous session; a long header is still indexed', () => withRecordingsDir(path.join(scratch, 'rec-d'), async () => {
    const rec = createRecorder(() => path.join(userData, 'recordings'));
    const first = (await rec.start({ note: 'x'.repeat(10000) })).sessionId;
    rec.append({ n: 1 });
    const second = (await rec.start()).sessionId;
    rec.append({ n: 2 });
    await rec.stop();
    const list = await rec.list();
    assert.deepEqual(list.map((s) => s.id).sort(), [first, second].sort());
    assert.deepEqual((await rec.load(first)).frames, [{ n: 1 }]);
    assert.deepEqual((await rec.load(second)).frames, [{ n: 2 }]);
  }));

  test('without EIS_RECORDINGS_DIR the default recorder writes under <userData>/recordings', async () => {
    const previous = process.env.EIS_RECORDINGS_DIR;
    delete process.env.EIS_RECORDINGS_DIR;
    try {
      const { sessionId } = await recorderMod.recorder.start();
      const stopped = await recorderMod.recorder.stop();
      assert.equal(stopped.path, path.join(userData, 'recordings', `${sessionId}.ndjson`));
    } finally {
      if (previous !== undefined) process.env.EIS_RECORDINGS_DIR = previous;
    }
    process.env.EIS_RECORDINGS_DIR = '   ';
    try {
      const stopped = await recorderMod.recorder.start().then(() => recorderMod.recorder.stop());
      assert.ok(stopped.path.startsWith(path.join(userData, 'recordings')), 'blank override is ignored');
    } finally {
      delete process.env.EIS_RECORDINGS_DIR;
    }
  });
});

/* ── IPC pure rules ─────────────────────────────────────────────────────── */

describe('ipc rules', () => {
  const { defaultConnectionConfig, siteAssetDataUrl, selectSiteFile, siteDirectory } = ipcMod;

  test('app:defaultConfig derives from the environment', () => {
    assert.deepEqual(defaultConnectionConfig({}), { host: 'sitl', controlPort: 8765, videoUrl: '', sitl: true });
    assert.deepEqual(defaultConnectionConfig({ EIS_HOST: '192.168.4.1', EIS_CONTROL_PORT: '9000', EIS_VIDEO_URL: 'http://cam/whep' }),
      { host: '192.168.4.1', controlPort: 9000, videoUrl: 'http://cam/whep', sitl: false });
    for (const flag of ['true', '1', 'yes', 'YES ']) {
      assert.equal(defaultConnectionConfig({ EIS_HOST: 'jetson', EIS_SITL: flag }).sitl, true, flag);
    }
    assert.equal(defaultConnectionConfig({ EIS_HOST: 'jetson', EIS_SITL: 'false' }).sitl, false);
    assert.equal(defaultConnectionConfig({ EIS_CONTROL_PORT: 'eight' }).controlPort, 8765, 'garbage port falls back');
  });

  test('site:resolveAsset only serves raster images inside the site directory', () => {
    const siteDir = path.join(scratch, 'site');
    const png = Buffer.from('89504e470d0a1a0a', 'hex');
    write(path.join(siteDir, 'stills', 'gate.png'), png);
    write(path.join(siteDir, 'site.json'), '{}');
    write(path.join(scratch, 'leak.png'), png);

    const expected = `data:image/png;base64,${png.toString('base64')}`;
    assert.equal(siteAssetDataUrl('site/stills/gate.png', siteDir), expected, 'contract paths are repo-root-relative');
    assert.equal(siteAssetDataUrl('stills\\gate.png', siteDir), expected, 'backslashes are normalised');
    assert.equal(siteAssetDataUrl('stills/GATE.PNG', siteDir), process.platform === 'win32' ? expected : null);
    assert.equal(siteAssetDataUrl('../leak.png', siteDir), null, 'no escaping the directory');
    assert.equal(siteAssetDataUrl(path.join(scratch, 'leak.png'), siteDir), null, 'absolute paths outside are refused');
    assert.equal(siteAssetDataUrl('site.json', siteDir), null, 'not an image');
    assert.equal(siteAssetDataUrl('', siteDir), null);
    assert.equal(siteAssetDataUrl('stills/gate.png\0', siteDir), null);
    assert.equal(siteAssetDataUrl(42, siteDir), null);
    assert.equal(siteAssetDataUrl('stills/missing.png', siteDir), null);
  });

  test('site:load picks EIS_SITE_FILE, else site.json, else the stub', () => {
    const root = path.join(scratch, 'root');
    write(path.join(root, 'site', 'site.stub.json'), '{}');
    assert.equal(selectSiteFile({}, root), path.join(root, 'site', 'site.stub.json'));
    write(path.join(root, 'site', 'site.json'), '{}');
    assert.equal(selectSiteFile({}, root), path.join(root, 'site', 'site.json'));
    assert.equal(selectSiteFile({ EIS_SITE_FILE: 'sites/alt.json' }, root), path.join(root, 'sites', 'alt.json'), 'explicit file never falls back');
    assert.equal(siteDirectory({ EIS_SITE_FILE: 'sites/alt.json' }, root), path.join(root, 'sites'));
    assert.equal(siteDirectory({}, root), path.join(root, 'site'));
  });
});

/* ── Shell runtime rules (main.ts) ──────────────────────────────────────── */

describe('main runtime rules', () => {
  const mainMod = require(path.join(dist, 'main.js'));
  const { describeRuntime, isNavigationAllowed, looksLikeGroundUi } = mainMod;

  test('dev vs packaged and the strict dev port', () => {
    assert.deepEqual(describeRuntime({}), { dev: false, devPort: 5173, devUrl: 'http://localhost:5173' });
    assert.equal(describeRuntime({ EIS_DEV: 'true' }).dev, true);
    assert.equal(describeRuntime({ NODE_ENV: 'development' }).dev, true);
    assert.equal(describeRuntime({ EIS_UI_PORT: '5199' }).devUrl, 'http://localhost:5199');
    assert.equal(describeRuntime({ EIS_UI_PORT: 'abc' }).devPort, 5173);
  });

  test('navigation stays on file:// or the dev server; everything else leaves the shell', () => {
    const packaged = describeRuntime({});
    const dev = describeRuntime({ EIS_DEV: 'true' });
    assert.equal(isNavigationAllowed('file:///C:/app/resources/ui/dist/index.html', packaged), true);
    assert.equal(isNavigationAllowed('http://localhost:5173/', packaged), false);
    assert.equal(isNavigationAllowed('http://localhost:5173/#/map', dev), true);
    assert.equal(isNavigationAllowed('https://leafletjs.com', dev), false);
    assert.equal(isNavigationAllowed('not a url', dev), false);
  });

  test('FM-131 identity markers', () => {
    assert.equal(looksLikeGroundUi('<title>Drone Safety Platform — Ground Control</title>'), true);
    assert.equal(looksLikeGroundUi('<script type="module" src="/src/main.tsx"></script>'), true);
    assert.equal(looksLikeGroundUi('<title>Some Console</title>'), false);
  });
});
