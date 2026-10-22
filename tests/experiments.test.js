import test from 'node:test';
import assert from 'node:assert/strict';
import { runExperiment, validateConfig, ENGINE_VERSION } from '../dist/lib/engine.js';
import { DEFAULT_CONFIG, WEAPONS } from '../dist/lib/presets.js';
import {
  parseExperiment, serializeExperiment, readHistory, historyRecord, resultCsv,
  STORAGE_KEY, MAX_IMPORT_BYTES,
} from '../dist/lib/experiments.js';

const fixture = runExperiment({ ...structuredClone(DEFAULT_CONFIG), trials: 32, seed: 1337 });

function exportDocument() {
  return structuredClone(fixture);
}

function withoutTimestamp(result) {
  const { createdAt, ...rest } = result;
  return rest;
}

function storageContaining(value) {
  return {
    getItem(key) {
      assert.equal(key, STORAGE_KEY);
      return value === undefined ? null : typeof value === 'string' ? value : JSON.stringify(value);
    },
  };
}

test('exported JSON restores exact normalized settings and reproduces computed results', () => {
  const json = serializeExperiment(fixture);
  const restored = parseExperiment(json);
  assert.deepEqual(restored, validateConfig(fixture.config));
  assert.deepEqual(withoutTimestamp(runExperiment(restored)), withoutTimestamp(fixture));
  assert.notEqual(restored, fixture.config);
});

test('large legal replay traces still export below the import limit and reconstruct exactly', () => {
  const result = runExperiment({ ...structuredClone(DEFAULT_CONFIG),
    weaponId: 'gatling', trials: 1, timeLimit: 180, squadSize: 1,
    enemy: { hp: 100000, damage: 0, interval: 10, count: 100, armor: 0 },
    patch: { damage: 0.01, interval: 0.02, critChance: 0 },
  });
  assert.ok(Buffer.byteLength(JSON.stringify(result, null, 2), 'utf8') > MAX_IMPORT_BYTES,
    'this fixture covers the previous oversized raw-trace export');
  const json = serializeExperiment(result);
  assert.ok(Buffer.byteLength(json, 'utf8') < MAX_IMPORT_BYTES);
  const exported = JSON.parse(json);
  assert.equal(Object.hasOwn(exported, 'replay'), false);
  assert.deepEqual(exported.baseline, result.baseline);
  assert.deepEqual(exported.patch, result.patch);
  const restored = parseExperiment(json);
  assert.deepEqual(restored, result.config);
  assert.deepEqual(withoutTimestamp(runExperiment(restored)), withoutTimestamp(result));
});

test('import ignores forged results and extra properties instead of trusting imported outcomes', () => {
  const document = exportDocument();
  document.baseline = { wins: 999999, winRate: 'not a probability' };
  document.patch = null;
  document.replay = '<script>untrusted()</script>';
  document.config.extraMarkup = '<img src=x onerror=untrusted()>';
  document.config.patch.displayName = '=HYPERLINK("https://example.com")';
  const restored = parseExperiment(JSON.stringify(document));
  assert.deepEqual(restored, fixture.config);
  assert.equal(Object.hasOwn(restored, 'extraMarkup'), false);
  assert.equal(Object.hasOwn(restored.patch, 'displayName'), false);
  assert.deepEqual(withoutTimestamp(runExperiment(restored)), withoutTimestamp(fixture));
});

test('null, array, invalid JSON, incomplete schemas and incompatible engines are rejected', () => {
  for (const text of ['null', '[]', '"text"', '{', '{}']) {
    assert.throws(() => parseExperiment(text));
  }
  for (const mutate of [
    (document) => { delete document.schemaVersion; },
    (document) => { document.schemaVersion = 2; },
    (document) => { document.schemaVersion = '1'; },
    (document) => { delete document.engineVersion; },
    (document) => { document.engineVersion = '0.9.0'; },
    (document) => { document.config = null; },
    (document) => { document.config = []; },
    (document) => { delete document.config.seed; },
    (document) => { delete document.config.trials; },
    (document) => { document.config.patch = null; },
    (document) => { document.config.patch = []; },
    (document) => { document.config.enemy = null; },
    (document) => { document.config.enemy = []; },
    (document) => { delete document.config.patch.critChance; },
    (document) => { delete document.config.enemy.armor; },
  ]) {
    const document = exportDocument();
    mutate(document);
    assert.throws(() => parseExperiment(JSON.stringify(document)));
  }
});

test('import enforces the file bound and does not coerce invalid or excessive workloads', () => {
  assert.throws(() => parseExperiment(' '.repeat(MAX_IMPORT_BYTES + 1)));
  assert.throws(() => parseExperiment(exportDocument()));
  for (const invalid of [
    { trials: 5001 }, { trials: '32' }, { trials: 0 },
    { seed: 4294967296 }, { weaponId: '=1+1' },
    { enemyId: '<script>' }, { timeLimit: null },
  ]) {
    const document = exportDocument();
    Object.assign(document.config, invalid);
    assert.throws(() => parseExperiment(JSON.stringify(document)), undefined, JSON.stringify(invalid));
  }
});

test('compact history preserves a detached reproducible configuration without replay payloads', () => {
  const record = historyRecord(fixture, 'experiment-001');
  assert.deepEqual(record.config, fixture.config);
  assert.equal(record.winDelta, fixture.delta.winRate);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.engineVersion, ENGINE_VERSION);
  assert.equal(Object.hasOwn(record, 'replay'), false);
  assert.equal(Object.hasOwn(record, 'baseline'), false);
  assert.notEqual(record.config, fixture.config);
  assert.notEqual(record.config.patch, fixture.config.patch);
  const [restored] = readHistory(storageContaining([record]));
  assert.deepEqual(withoutTimestamp(runExperiment(restored.config)), withoutTimestamp(fixture));
});

test('history restoration drops corrupted entries and bounds metadata without losing valid neighbors', () => {
  const valid = historyRecord(fixture, 'valid');
  const longId = historyRecord(fixture, 'x'.repeat(300));
  longId.winDelta = '999';
  const excessiveDelta = historyRecord(fixture, 'bad-delta');
  excessiveDelta.winDelta = 20;
  const wrongVersion = { ...valid, id: 'wrong-version', engineVersion: '2.0.0' };
  const incomplete = structuredClone(valid);
  delete incomplete.config.enemy.count;
  const restored = readHistory(storageContaining([
    null, [], {}, { ...valid, createdAt: 'invalid date' }, wrongVersion, incomplete,
    valid, longId, excessiveDelta,
  ]));
  assert.equal(restored.length, 3);
  assert.equal(restored[0].id, 'valid');
  assert.equal(restored[1].id.length, 80);
  assert.equal(restored[1].winDelta, 0);
  assert.equal(restored[2].winDelta, 0);
  assert.deepEqual(restored[0].config, fixture.config);
  const many = Array.from({ length: 35 }, (_, index) => historyRecord(fixture, `run-${index}`));
  assert.equal(readHistory(storageContaining(many)).length, 20);
});

test('empty history is safe and malformed or inaccessible storage fails explicitly', () => {
  assert.deepEqual(readHistory(storageContaining()), []);
  assert.throws(() => readHistory(storageContaining('{')));
  assert.throws(() => readHistory(storageContaining({ entries: [] })));
  assert.throws(() => readHistory(storageContaining('null')));
  assert.throws(() => readHistory({ getItem() { throw new Error('storage unavailable'); } }), /storage unavailable/);
});

test('CSV keeps baseline weapon stats and both sets of computed metrics in the right columns', () => {
  const baselineWeapon = WEAPONS.find((weapon) => weapon.id === fixture.config.weaponId);
  const csv = resultCsv({ ...fixture, baselineWeapon });
  assert.equal(csv.charCodeAt(0), 0xFEFF, 'UTF-8 BOM supports Korean spreadsheet applications');
  const [header, ...rows] = csv.slice(1).split('\r\n').map((line) => line.split(','));
  assert.equal(rows.length, 2);
  assert.equal(new Set(header).size, header.length);
  assert.equal(header.length, 23);
  const exported = Object.fromEntries(rows.map((row) => {
    assert.equal(row.length, header.length);
    const record = Object.fromEntries(header.map((key, index) => [key, row[index]]));
    return [record.variant, record];
  }));
  for (const [variant, weapon] of [['baseline', baselineWeapon], ['patch', fixture.config.patch]]) {
    const row = exported[variant];
    const stats = fixture[variant];
    assert.equal(row.weapon, fixture.config.weaponId);
    assert.equal(row.enemy, fixture.config.enemyId);
    for (const [column, expected] of Object.entries({
      seed: fixture.config.seed, trials: fixture.config.trials, wins: stats.wins,
      win_rate: stats.winRate, wilson_95_lower: stats.ci[0], wilson_95_upper: stats.ci[1],
      mean_duration_sec: stats.meanDuration, mean_effective_damage: stats.meanDamage,
      mean_remaining_hp: stats.meanHp, damage: weapon.damage, interval_sec: weapon.interval,
      crit_chance: weapon.critChance, squad_size: fixture.config.squadSize,
      squad_hp: fixture.config.playerHp, time_limit_sec: fixture.config.timeLimit,
      enemy_hp: fixture.config.enemy.hp, enemy_damage: fixture.config.enemy.damage,
      enemy_interval_sec: fixture.config.enemy.interval, enemy_count: fixture.config.enemy.count,
      enemy_armor: fixture.config.enemy.armor,
    })) {
      assert.equal(Number(row[column]), expected, `${variant}.${column}`);
    }
  }
  assert.notEqual(exported.baseline.damage, exported.patch.damage, 'patch inputs must not overwrite the exported baseline');
  assert.equal(/undefined|NaN|Infinity/.test(csv), false);
});
