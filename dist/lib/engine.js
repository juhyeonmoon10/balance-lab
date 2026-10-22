import { WEAPONS, ENEMIES, DEFAULT_CONFIG } from './presets.js';

export const ENGINE_VERSION = '1.0.0';
const EPSILON = 1e-9;
const UINT_MAX = 4294967295;

function number(value, fallback, label, min, max, integer = false) {
  const result = value === undefined ? fallback : value;
  if (typeof result !== 'number' || !Number.isFinite(result) || result < min || result > max || (integer && !Number.isInteger(result))) {
    throw new Error(`${label}: ${min}~${max} 범위의 ${integer ? '정수' : '숫자'}를 입력해 주세요.`);
  }
  return result;
}

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 설정은 객체여야 합니다.`);
  }
  return value;
}

/** Validate and copy the public schema. Numeric strings are rejected deliberately. */
export function validateConfig(input = {}) {
  object(input, '실험');
  const weaponId = input.weaponId === undefined ? DEFAULT_CONFIG.weaponId : input.weaponId;
  const enemyId = input.enemyId === undefined ? DEFAULT_CONFIG.enemyId : input.enemyId;
  const weapon = WEAPONS.find((entry) => entry.id === weaponId);
  const enemyPreset = ENEMIES.find((entry) => entry.id === enemyId);
  if (!weapon) throw new Error('선택한 무기 프리셋을 찾을 수 없습니다.');
  if (!enemyPreset) throw new Error('선택한 적 프리셋을 찾을 수 없습니다.');
  const patch = object(input.patch === undefined ? {} : input.patch, '변경 무기');
  const enemy = object(input.enemy === undefined ? {} : input.enemy, '적');
  const patchFallback = weaponId === DEFAULT_CONFIG.weaponId ? DEFAULT_CONFIG.patch : weapon;
  return {
    weaponId,
    enemyId,
    trials: number(input.trials, DEFAULT_CONFIG.trials, '실험 횟수', 1, 5000, true),
    seed: number(input.seed, DEFAULT_CONFIG.seed, '시드', 0, UINT_MAX, true),
    squadSize: number(input.squadSize, DEFAULT_CONFIG.squadSize, '분대 병력', 1, 100, true),
    playerHp: number(input.playerHp, DEFAULT_CONFIG.playerHp, '분대 체력', 1, 10000),
    timeLimit: number(input.timeLimit, DEFAULT_CONFIG.timeLimit, '제한 시간', 1, 180),
    patch: {
      damage: number(patch.damage, patchFallback.damage, '변경 피해량', 0.01, 1000),
      interval: number(patch.interval, patchFallback.interval, '변경 발사 간격', 0.02, 10),
      critChance: number(patch.critChance, patchFallback.critChance, '변경 치명타 확률', 0, 1),
    },
    enemy: {
      hp: number(enemy.hp, enemyPreset.hp, '적 체력', 1, 100000),
      damage: number(enemy.damage, enemyPreset.damage, '적 공격 피해', 0, 1000),
      interval: number(enemy.interval, enemyPreset.interval, '적 공격 간격', 0.1, 10),
      count: number(enemy.count, enemyPreset.count, '적 수', 1, 100, true),
      armor: number(enemy.armor, enemyPreset.armor, '적 피해 감소율', 0, 0.9),
    },
  };
}

/** Counter-based uint32 hash; channels isolate target HP, attack timing, damage and crits. */
function uniform(seed, channel, index) {
  let value = (seed ^ channel ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  return ((value ^ (value >>> 15)) >>> 0) / 4294967296;
}

export function trialSeed(seed, trialIndex) {
  return (seed + Math.imul(trialIndex, 0x9e3779b9)) >>> 0;
}

/**
 * Abstract event-driven encounter, NOT a reproduction of the original 3D game.
 * One enemy is active at a time; the next spawns immediately after a kill. The
 * squad stays fixed in size even as its shared HP falls. Each weapon interval,
 * all soldiers fire once; crits are independent and excess damage is discarded.
 * Enemy HP varies +/-15%, hit damage +/-10%, and the first enemy attack occurs
 * after 50..100% of its interval. These lab assumptions are shared by paired runs
 * through counter-based random channels. Equal-time events resolve squad-first.
 * A timeout is a failed clear even when HP remains. Damage is effective damage,
 * after armor and excluding overkill. Shots counts individual projectiles.
 */
function battle(config, variant, seed, trace) {
  const preset = WEAPONS.find((weapon) => weapon.id === config.weaponId);
  const weapon = variant === 'patch' ? { ...preset, ...config.patch } : preset;
  const enemy = config.enemy;
  let playerHp = config.playerHp;
  let enemyHp = enemy.hp * (0.85 + 0.3 * uniform(seed, 0x12faca01, 0));
  let nextShot = weapon.interval;
  let nextAttack = enemy.interval * (0.5 + 0.5 * uniform(seed, 0x2bc721da, 0));
  let attackIndex = 0;
  let time = 0;
  let damageDealt = 0;
  let kills = 0;
  let shots = 0;
  let crits = 0;
  const timeline = [];
  const record = () => {
    if (!trace) return;
    const point = { time, playerHp, enemyHp, damageDealt, kills, shots, crits };
    if (timeline.length && Math.abs(timeline[timeline.length - 1].time - time) < EPSILON) timeline[timeline.length - 1] = point;
    else timeline.push(point);
  };
  record();
  while (playerHp > 0 && kills < enemy.count) {
    const eventTime = Math.min(nextShot, nextAttack);
    if (eventTime > config.timeLimit + EPSILON) {
      time = config.timeLimit;
      break;
    }
    time = Math.min(eventTime, config.timeLimit);
    if (nextShot <= nextAttack + EPSILON) {
      let volleyCrits = 0;
      for (let soldier = 0; soldier < config.squadSize; soldier++) {
        if (uniform(seed, 0x4adcfa13, shots + soldier) < weapon.critChance) volleyCrits++;
      }
      shots += config.squadSize;
      crits += volleyCrits;
      const damage = weapon.damage * (config.squadSize + volleyCrits * (weapon.critMultiplier - 1)) * (1 - enemy.armor);
      const effectiveDamage = Math.min(enemyHp, damage);
      damageDealt += effectiveDamage;
      enemyHp = Math.max(0, enemyHp - effectiveDamage);
      nextShot += weapon.interval;
      if (enemyHp <= EPSILON) {
        kills++;
        if (kills < enemy.count) {
          enemyHp = enemy.hp * (0.85 + 0.3 * uniform(seed, 0x12faca01, kills));
          nextAttack = time + enemy.interval * (0.5 + 0.5 * uniform(seed, 0x2bc721da, kills));
          attackIndex = 0;
        }
      }
    } else {
      const damage = enemy.damage * (0.9 + 0.2 * uniform(seed, 0x3d219bbb, kills * 10000 + attackIndex));
      playerHp = Math.max(0, playerHp - damage);
      attackIndex++;
      nextAttack += enemy.interval;
    }
    record();
  }
  record();
  return { won: kills === enemy.count && playerHp > 0, duration: time, damageDealt, remainingHp: playerHp, kills, shots, crits, timeline, seed };
}

export function simulateBattle(input, options = {}) {
  const config = validateConfig(input);
  object(options, '전투');
  const variant = options.variant === undefined ? 'baseline' : options.variant;
  if (variant !== 'baseline' && variant !== 'patch') throw new Error('전투 종류는 baseline 또는 patch여야 합니다.');
  const seed = number(options.seed, config.seed, '전투 시드', 0, UINT_MAX, true);
  return battle(config, variant, seed, options.trace === true);
}

/** 95% Wilson score interval; unlike a normal interval it behaves at 0/N and N/N. */
export function wilsonInterval(wins, trials) {
  number(trials, undefined, '표본 수', 1, Number.MAX_SAFE_INTEGER, true);
  number(wins, undefined, '승리 수', 0, trials, true);
  const z = 1.959963984540054;
  const z2 = z * z;
  const proportion = wins / trials;
  const denominator = 1 + z2 / trials;
  const center = (proportion + z2 / (2 * trials)) / denominator;
  const spread = z * Math.sqrt(proportion * (1 - proportion) / trials + z2 / (4 * trials * trials)) / denominator;
  return [Math.max(0, center - spread), Math.min(1, center + spread)];
}

function pairedTrial(config, trialIndex) {
  const seed = trialSeed(config.seed, trialIndex);
  return { seed, baseline: battle(config, 'baseline', seed, false), patch: battle(config, 'patch', seed, false) };
}

/** Zero-based trial index permits chunking in a Web Worker without changing seeds. */
export function runTrial(input, trialIndex) {
  const config = validateConfig(input);
  number(trialIndex, undefined, '실험 순번', 0, config.trials - 1, true);
  return pairedTrial(config, trialIndex);
}

function summarize(config, battles) {
  const trials = battles.length;
  let wins = 0;
  let duration = 0;
  let damage = 0;
  let hp = 0;
  const durations = [];
  const deaths = [];
  for (const result of battles) {
    wins += result.won ? 1 : 0;
    duration += result.duration;
    damage += result.damageDealt;
    hp += result.remainingHp;
    durations.push(result.duration);
    if (result.remainingHp <= 0) deaths.push(result.duration);
  }
  deaths.sort((a, b) => a - b);
  const survival = [];
  let dead = 0;
  // At most 181 points, retaining the configured fractional endpoint.
  for (let tick = 0; tick <= Math.ceil(config.timeLimit); tick++) {
    const time = Math.min(tick, config.timeLimit);
    while (dead < deaths.length && deaths[dead] <= time + EPSILON) dead++;
    survival.push({ time, rate: (trials - dead) / trials });
  }
  return { winRate: wins / trials, wins, trials, ci: wilsonInterval(wins, trials), meanDuration: duration / trials, meanDamage: damage / trials, meanHp: hp / trials, survival, durations };
}

/** Aggregate exactly config.trials paired outcomes; output timestamp is not deterministic. */
export function aggregateResults(input, trialResults) {
  const config = validateConfig(input);
  if (!Array.isArray(trialResults) || trialResults.length !== config.trials) throw new Error('집계할 전투 수가 설정한 실험 횟수와 일치하지 않습니다.');
  for (let i = 0; i < trialResults.length; i++) {
    const result = trialResults[i];
    const expectedSeed = trialSeed(config.seed, i);
    if (!result || result.seed !== expectedSeed || result.baseline?.seed !== expectedSeed || result.patch?.seed !== expectedSeed) {
      throw new Error('전투 결과의 시드 또는 순서가 실험 설정과 일치하지 않습니다.');
    }
  }
  const baseline = summarize(config, trialResults.map((result) => result.baseline));
  const patch = summarize(config, trialResults.map((result) => result.patch));
  return {
    schemaVersion: 1,
    engineVersion: ENGINE_VERSION,
    config,
    baseline,
    patch,
    delta: { winRate: patch.winRate - baseline.winRate, meanDuration: patch.meanDuration - baseline.meanDuration, meanDamage: patch.meanDamage - baseline.meanDamage },
    replay: { baseline: battle(config, 'baseline', config.seed, true), patch: battle(config, 'patch', config.seed, true) },
    createdAt: new Date().toISOString(),
  };
}

export function runExperiment(input) {
  const config = validateConfig(input);
  const trialResults = Array.from({ length: config.trials }, (_, index) => pairedTrial(config, index));
  return aggregateResults(config, trialResults);
}
