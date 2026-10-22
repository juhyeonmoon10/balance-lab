import test from 'node:test';
import assert from 'node:assert/strict';
import { WEAPONS, ENEMIES, DEFAULT_CONFIG } from '../dist/lib/presets.js';
import {
  validateConfig, simulateBattle, runExperiment, runTrial,
  aggregateResults, wilsonInterval,
} from '../dist/lib/engine.js';

function config(overrides = {}) {
  const base = structuredClone(DEFAULT_CONFIG);
  return validateConfig({ ...base, ...overrides,
    patch: { ...base.patch, ...overrides.patch },
    enemy: { ...base.enemy, ...overrides.enemy },
  });
}

function withoutTimestamp(result) {
  const { createdAt, ...rest } = result;
  return rest;
}

function unchangedWeaponConfig(overrides = {}) {
  const weapon = WEAPONS.find((entry) => entry.id === (overrides.weaponId ?? DEFAULT_CONFIG.weaponId));
  return config({ ...overrides, patch: {
    damage: weapon.damage, interval: weapon.interval, critChance: weapon.critChance,
  } });
}

test('original weapon damage, firing intervals and critical values are preserved', () => {
  // Independent source: LastWarSurvivar index.html CONFIG.weapons and CONFIG.crit*.
  // fireRate in that source is seconds between shots, not shots per second.
  const expected = {
    pistol: { damage: 1, interval: 0.35 },
    ak: { damage: 1, interval: 0.1 },
    gatling: { damage: 2, interval: 0.05 },
  };
  assert.deepEqual(WEAPONS.map((weapon) => weapon.id).sort(), Object.keys(expected).sort());
  for (const weapon of WEAPONS) {
    assert.equal(weapon.damage, expected[weapon.id].damage, weapon.id);
    assert.equal(weapon.interval, expected[weapon.id].interval, weapon.id);
    assert.equal(weapon.critChance, 0.1, weapon.id);
    assert.equal(weapon.critMultiplier, 2, weapon.id);
  }
});

test('default and JSON-imported configurations normalize to the same valid values', () => {
  const original = structuredClone(DEFAULT_CONFIG);
  const normalized = validateConfig(original);
  assert.deepEqual(validateConfig(JSON.parse(JSON.stringify(original))), normalized);
  assert.deepEqual(original, DEFAULT_CONFIG, 'validation must not mutate the imported object');
  assert.ok(WEAPONS.some((weapon) => weapon.id === normalized.weaponId));
  assert.ok(ENEMIES.some((enemy) => enemy.id === normalized.enemyId));
});

test('untrusted settings reject invalid types, preset IDs, and out-of-range workloads', () => {
  for (const invalid of [
    { trials: 0 }, { trials: 5001 }, { trials: 1.5 }, { trials: '100' },
    { seed: -1 }, { seed: 4294967296 }, { seed: 1.5 },
    { squadSize: 0 }, { squadSize: 101 },
    { playerHp: 0 }, { playerHp: Infinity },
    { timeLimit: 0 }, { timeLimit: 181 },
    { weaponId: 'unknown-weapon' }, { enemyId: 'unknown-enemy' },
    { patch: { damage: 0 } }, { patch: { damage: 1001 } },
    { patch: { interval: 0 } }, { patch: { interval: 0.019 } },
    { patch: { critChance: -0.01 } }, { patch: { critChance: 1.01 } },
    { patch: { damage: NaN } }, { patch: { interval: '0.1' } },
    { enemy: { count: 0 } }, { enemy: { count: 101 } },
    { enemy: { armor: -0.01 } }, { enemy: { armor: 0.91 } },
    { enemy: { hp: 0 } }, { enemy: { damage: -1 } },
    { enemy: { interval: 0 } },
  ]) {
    assert.throws(() => config(invalid), undefined, JSON.stringify(invalid));
  }
  for (const invalid of [null, [], 'configuration']) {
    assert.throws(() => validateConfig(invalid));
  }
  assert.throws(() => runExperiment({ ...DEFAULT_CONFIG, trials: 5001 }));
});

test('documented workload and probability boundary values are valid', () => {
  assert.equal(config({ trials: 1, seed: 0 }).trials, 1);
  const upper = config({ trials: 5000, seed: 4294967295, timeLimit: 180,
    squadSize: 100, patch: { critChance: 1, interval: 0.02 },
    enemy: { armor: 0.9, damage: 0 },
  });
  assert.equal(upper.trials, 5000);
  assert.equal(upper.seed, 4294967295);
  assert.equal(config({ patch: { critChance: 0 } }).patch.critChance, 0);
});

test('a battle and aggregate results reproduce exactly for the same seed and configuration', () => {
  const settings = config({ trials: 32, seed: 241022 });
  assert.deepEqual(
    simulateBattle(settings, { variant: 'patch', seed: 400, trace: true }),
    simulateBattle(settings, { variant: 'patch', seed: 400, trace: true }),
  );
  const first = runExperiment(settings);
  const second = runExperiment(settings);
  assert.deepEqual(withoutTimestamp(first), withoutTimestamp(second));
  assert.equal(first.schemaVersion, 1);
  assert.equal(first.engineVersion, '1.0.0');
  assert.ok(Number.isFinite(Date.parse(first.createdAt)));
});

test('identical baseline and patch values produce identical paired trials and statistics', () => {
  for (const weapon of WEAPONS) {
    const settings = unchangedWeaponConfig({ weaponId: weapon.id, trials: 40, seed: 12345 });
    const result = runExperiment(settings);
    assert.deepEqual(result.baseline, result.patch, weapon.id);
    assert.deepEqual(result.replay.baseline, result.replay.patch, weapon.id);
  }
});

test('trial aggregation agrees with the all-at-once experiment path', () => {
  const settings = config({ trials: 12, seed: 774 });
  const trials = Array.from({ length: settings.trials }, (_, index) => runTrial(settings, index));
  assert.equal(new Set(trials.map((trial) => trial.seed)).size, settings.trials);
  const incremental = aggregateResults(settings, trials);
  assert.deepEqual(withoutTimestamp(incremental), withoutTimestamp(runExperiment(settings)));
});

test('Wilson intervals stay informative at zero wins and all wins', () => {
  const zero = wilsonInterval(0, 100);
  const all = wilsonInterval(100, 100);
  const half = wilsonInterval(50, 100);
  assert.ok(Math.abs(zero[0]) < 1e-12);
  assert.ok(zero[1] > 0.036 && zero[1] < 0.038);
  assert.ok(all[0] > 0.962 && all[0] < 0.964);
  assert.ok(Math.abs(all[1] - 1) < 1e-12);
  assert.ok(Math.abs(half[0] - 0.40383) < 0.0001);
  assert.ok(Math.abs(half[1] - 0.59617) < 0.0001);
  assert.ok(Math.abs(zero[1] - (1 - all[0])) < 1e-12);
  for (const trials of [1, 2, 10, 100, 5000]) {
    for (const wins of [0, Math.floor(trials / 2), trials]) {
      const [lower, upper] = wilsonInterval(wins, trials);
      assert.ok(Number.isFinite(lower) && Number.isFinite(upper));
      assert.ok(lower >= 0 && upper <= 1 && lower <= upper);
    }
  }
});

test('battle traces preserve finite bounds and monotonic event counters', () => {
  for (const weapon of WEAPONS) {
    for (const enemy of ENEMIES) {
      const settings = unchangedWeaponConfig({ weaponId: weapon.id, enemyId: enemy.id,
        enemy: { hp: enemy.hp, damage: enemy.damage, interval: enemy.interval,
          count: enemy.count, armor: enemy.armor },
      });
      const battle = simulateBattle(settings, { variant: 'baseline', seed: 83, trace: true });
      assert.ok(Number.isFinite(battle.duration) && battle.duration >= 0 && battle.duration <= settings.timeLimit);
      assert.ok(Number.isFinite(battle.damageDealt) && battle.damageDealt >= 0);
      assert.ok(Number.isFinite(battle.remainingHp) && battle.remainingHp >= 0 && battle.remainingHp <= settings.playerHp);
      assert.ok(Number.isInteger(battle.kills) && battle.kills >= 0 && battle.kills <= settings.enemy.count);
      assert.ok(Number.isInteger(battle.shots) && battle.shots >= 0);
      assert.ok(Number.isInteger(battle.crits) && battle.crits >= 0 && battle.crits <= battle.shots);
      assert.ok(battle.timeline.length > 0);
      let previous = { time: 0, playerHp: settings.playerHp, damageDealt: 0, kills: 0, shots: 0, crits: 0 };
      for (const point of battle.timeline) {
        for (const key of ['time', 'playerHp', 'enemyHp', 'damageDealt', 'kills', 'shots', 'crits']) {
          assert.ok(Number.isFinite(point[key]), `${weapon.id}/${enemy.id}: ${key}`);
          assert.ok(point[key] >= 0, `${key} must not become negative`);
        }
        assert.ok(point.time >= previous.time && point.time <= settings.timeLimit);
        assert.ok(point.playerHp <= previous.playerHp);
        for (const key of ['damageDealt', 'kills', 'shots', 'crits']) assert.ok(point[key] >= previous[key]);
        previous = point;
      }
      if (battle.won) assert.equal(battle.kills, settings.enemy.count);
    }
  }
});

test('time-limit censoring is a non-win while a living player retains HP', () => {
  const settings = config({ squadSize: 1, playerHp: 50, timeLimit: 1,
    patch: { damage: 0.01, interval: 10, critChance: 0 },
    enemy: { hp: 100000, damage: 0, count: 1 },
  });
  const battle = simulateBattle(settings, { variant: 'patch', seed: 7, trace: true });
  assert.equal(battle.won, false);
  assert.equal(battle.duration, 1);
  assert.equal(battle.remainingHp, 50);
  assert.equal(battle.kills, 0);
  assert.equal(battle.shots, 0, 'first shot must wait for the configured firing interval');
  assert.equal(battle.damageDealt, 0);
});

test('critical probability endpoints preserve the per-projectile damage formula', () => {
  const settings = config({ squadSize: 3, playerHp: 100, timeLimit: 1,
    patch: { damage: 1, interval: 0.25, critChance: 0 },
    enemy: { hp: 100000, damage: 0, count: 1, armor: 0 },
  });
  const ordinary = simulateBattle(settings, { variant: 'patch', seed: 123 });
  const critical = simulateBattle({ ...settings, patch: { ...settings.patch, critChance: 1 } },
    { variant: 'patch', seed: 123 });
  assert.equal(ordinary.shots, 12);
  assert.equal(ordinary.crits, 0);
  assert.equal(ordinary.damageDealt, 12);
  assert.equal(critical.shots, 12);
  assert.equal(critical.crits, 12);
  assert.equal(critical.damageDealt, 24);
});

test('overkill does not spill into the next enemy or inflate effective damage', () => {
  const settings = config({ squadSize: 1, timeLimit: 1,
    patch: { damage: 1000, interval: 0.75, critChance: 0 },
    enemy: { hp: 1, damage: 0, count: 2, armor: 0 },
  });
  const battle = simulateBattle(settings, { variant: 'patch', seed: 18 });
  assert.equal(battle.shots, 1);
  assert.equal(battle.kills, 1);
  assert.equal(battle.won, false);
  assert.ok(battle.damageDealt >= 0.85 && battle.damageDealt <= 1.15);
});

test('a decisive weapon buff improves wins in a deliberately difficult encounter', () => {
  const settings = config({ weaponId: 'pistol', trials: 48, seed: 123456,
    squadSize: 1, playerHp: 50, timeLimit: 30,
    patch: { damage: 1000, interval: 0.02, critChance: 1 },
    enemy: { hp: 500, damage: 15, interval: 0.5, count: 3, armor: 0.1 },
  });
  const result = runExperiment(settings);
  assert.equal(result.baseline.wins, 0);
  assert.equal(result.patch.wins, settings.trials);
  assert.equal(result.delta.winRate, 1);
  assert.ok(result.patch.meanDuration < result.baseline.meanDuration);
  assert.ok(result.patch.meanHp > result.baseline.meanHp);
});

test('different seeds exercise different stochastic battle outcomes', () => {
  const settings = config({ weaponId: 'ak', squadSize: 3, playerHp: 100, timeLimit: 30,
    enemy: { hp: 500, damage: 3, interval: 0.5, count: 3, armor: 0 },
  });
  const outcomes = Array.from({ length: 8 }, (_, index) => {
    const { seed, ...outcome } = simulateBattle(settings, { variant: 'baseline', seed: index + 1, trace: true });
    return JSON.stringify(outcome);
  });
  assert.ok(new Set(outcomes).size > 1, 'seed must influence simulation, not only result metadata');
});

test('aggregate statistics agree with their counts and survival remains a bounded nonincreasing curve', () => {
  const settings = config({ trials: 45, seed: 987 });
  const result = runExperiment(settings);
  for (const summary of [result.baseline, result.patch]) {
    assert.equal(summary.trials, settings.trials);
    assert.equal(summary.winRate, summary.wins / summary.trials);
    assert.equal(summary.durations.length, settings.trials);
    assert.ok(Math.abs(summary.meanDuration - summary.durations.reduce((sum, value) => sum + value, 0) / settings.trials) < 1e-9);
    assert.deepEqual(summary.ci, wilsonInterval(summary.wins, summary.trials));
    for (const key of ['meanDuration', 'meanDamage', 'meanHp']) assert.ok(Number.isFinite(summary[key]) && summary[key] >= 0);
    let previous = { time: 0, rate: 1 };
    for (const point of summary.survival) {
      assert.ok(Number.isFinite(point.time) && point.time >= previous.time && point.time <= settings.timeLimit);
      assert.ok(Number.isFinite(point.rate) && point.rate >= 0 && point.rate <= previous.rate);
      previous = point;
    }
    assert.ok(summary.survival.length > 1);
  }
  assert.equal(result.delta.winRate, result.patch.winRate - result.baseline.winRate);
  assert.equal(result.delta.meanDuration, result.patch.meanDuration - result.baseline.meanDuration);
  assert.equal(result.delta.meanDamage, result.patch.meanDamage - result.baseline.meanDamage);
});
