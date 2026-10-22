import { validateConfig, ENGINE_VERSION } from './engine.js';

export const STORAGE_KEY = 'balance-lab.experiments.v1';
export const MAX_IMPORT_BYTES = 2_000_000;

/** Trace events are reconstructed from config, keeping even worst-case exports small. */
export function serializeExperiment(result) {
  const { schemaVersion, engineVersion, config, baseline, patch, delta, createdAt } = result;
  return JSON.stringify({ schemaVersion, engineVersion, config, baseline, patch, delta, createdAt }, null, 2);
}

/** Imported numbers are never trusted as results: only validated config is reused. */
export function parseExperiment(text) {
  if (typeof text !== 'string' || text.length > MAX_IMPORT_BYTES) throw new Error('2MB 이하의 실험 JSON 파일을 선택해 주세요.');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('올바른 JSON 파일이 아닙니다.'); }
  if (!data || data.schemaVersion !== 1 || data.engineVersion !== ENGINE_VERSION || !data.config || typeof data.config !== 'object') {
    throw new Error(`이 파일은 엔진 ${ENGINE_VERSION}의 실험 파일이 아닙니다.`);
  }
  const keys = ['weaponId', 'enemyId', 'trials', 'seed', 'squadSize', 'playerHp', 'timeLimit', 'patch', 'enemy'];
  if (keys.some((key) => !Object.hasOwn(data.config, key)) || !data.config.patch || !data.config.enemy ||
    ['damage', 'interval', 'critChance'].some((key) => !Object.hasOwn(data.config.patch, key)) ||
    ['hp', 'damage', 'interval', 'count', 'armor'].some((key) => !Object.hasOwn(data.config.enemy, key))) {
    throw new Error('실험 설정의 필수 항목이 빠져 있습니다.');
  }
  return validateConfig(data.config);
}

/** A deliberately compact history; simulation output is recomputed when restored. */
export function readHistory(storage) {
  const entries = JSON.parse(storage.getItem(STORAGE_KEY) || '[]');
  if (!Array.isArray(entries)) throw new Error('저장된 실험 기록 형식을 읽을 수 없습니다.');
  return entries.slice(0, 20).flatMap((entry) => {
    try {
      if (!entry || typeof entry.id !== 'string' || typeof entry.createdAt !== 'string' || !Number.isFinite(Date.parse(entry.createdAt))) return [];
      const config = parseExperiment(JSON.stringify(entry));
      const winDelta = typeof entry.winDelta === 'number' && Number.isFinite(entry.winDelta) && Math.abs(entry.winDelta) <= 1 ? entry.winDelta : 0;
      return [{ id: entry.id.slice(0, 80), createdAt: entry.createdAt, schemaVersion: 1, engineVersion: ENGINE_VERSION, config, winDelta }];
    } catch { return []; }
  });
}

export function historyRecord(result, id) {
  return { id, createdAt: result.createdAt, schemaVersion: 1, engineVersion: ENGINE_VERSION, config: validateConfig(result.config), winDelta: result.delta.winRate };
}

export function resultCsv(result) {
  const rows = [
    ['variant', 'weapon', 'enemy', 'seed', 'trials', 'wins', 'win_rate', 'wilson_95_lower', 'wilson_95_upper', 'mean_duration_sec', 'mean_effective_damage', 'mean_remaining_hp', 'damage', 'interval_sec', 'crit_chance', 'squad_size', 'squad_hp', 'time_limit_sec', 'enemy_hp', 'enemy_damage', 'enemy_interval_sec', 'enemy_count', 'enemy_armor'],
  ];
  const config = result.config;
  // Original weapon stats must come from the actual preset, not from patch input.
  for (const [key, weapon] of [['baseline', result.baselineWeapon], ['patch', config.patch]]) {
    const item = result[key];
    rows.push([key, config.weaponId, config.enemyId, config.seed, config.trials, item.wins, item.winRate, ...item.ci, item.meanDuration, item.meanDamage, item.meanHp, weapon.damage, weapon.interval, weapon.critChance, config.squadSize, config.playerHp, config.timeLimit, config.enemy.hp, config.enemy.damage, config.enemy.interval, config.enemy.count, config.enemy.armor]);
  }
  return '\uFEFF' + rows.map((row) => row.join(',')).join('\r\n');
}
