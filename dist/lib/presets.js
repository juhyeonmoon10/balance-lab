/**
 * Weapon damage, firing intervals and critical values come from LastWarSurvivar's
 * public CONFIG, not from measurements of its live physics or collision system.
 * Source: https://github.com/juhyeonmoon10/LastWarSurvivar/blob/main/index.html
 * Enemies and encounter settings below are deliberately invented lab scenarios.
 */
export const WEAPONS = [
  { id: 'pistol', name: 'Pistol', subtitle: '기본 권총', damage: 1, interval: 0.35, critChance: 0.1, critMultiplier: 2, color: '#96b8ff' },
  { id: 'ak', name: 'AK-47', subtitle: '균형 잡힌 연사', damage: 1, interval: 0.1, critChance: 0.1, critMultiplier: 2, color: '#b8ed64' },
  { id: 'gatling', name: 'Gatling', subtitle: '고속 화력', damage: 2, interval: 0.05, critChance: 0.1, critMultiplier: 2, color: '#ffb26b' },
];

export const ENEMIES = [
  { id: 'swarm', name: 'Swarm', hp: 90, damage: 18, interval: 0.75, count: 6, armor: 0.1 },
  { id: 'brute', name: 'Brute', hp: 420, damage: 13, interval: 1.1, count: 3, armor: 0.2 },
  { id: 'boss', name: 'Boss', hp: 1800, damage: 15, interval: 1.8, count: 1, armor: 0.25 },
];

export const DEFAULT_CONFIG = {
  weaponId: 'ak',
  enemyId: 'swarm',
  trials: 500,
  seed: 2048,
  squadSize: 12,
  playerHp: 100,
  timeLimit: 45,
  patch: { damage: 1.15, interval: 0.09, critChance: 0.1 },
  enemy: { hp: 90, damage: 18, interval: 0.75, count: 6, armor: 0.1 },
};
