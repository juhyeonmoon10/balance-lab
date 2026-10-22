import { WEAPONS, ENEMIES, DEFAULT_CONFIG } from './lib/presets.js';
import { validateConfig, runTrial, aggregateResults } from './lib/engine.js';
import { STORAGE_KEY, MAX_IMPORT_BYTES, parseExperiment, readHistory, historyRecord, resultCsv, serializeExperiment } from './lib/experiments.js';

const $ = (id) => document.getElementById(id);
const clone = (value) => structuredClone(value);
const format = (number, digits = 1) => Number(number).toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
const sign = (value, digits = 1) => `${value > 0 ? '+' : ''}${format(value, digits)}`;
const percent = (value) => `${format(value * 100)}%`;
const weaponNames = { pistol: '권총', ak: 'AK-47', gatling: '개틀링' };
const enemyNames = { swarm: '군집 · SWARM', brute: '중장갑 · BRUTE', boss: '보스 · BOSS' };
const state = { config: clone(DEFAULT_CONFIG), result: null, history: [], busy: false, sequence: 0, activeId: 0, worker: null, dirty: false, graph: 'survival', replayTime: 0, playing: false, lastFrame: 0, toastTimer: 0 };
const weaponIcons = {
  pistol: '<path d="M5 6h30v9H19l-3 11H7l3-11H5zM32 3h3v3h-3zM19 16h6v5h-8v-3h5v-2z"/>',
  ak: '<path d="M2 11h9V8h20v3h12v3H26l-3 12h-7l3-12h-6l-5 8H3l2-8H2zM25 4h4v4h-4zM32 7h4v3h-4z"/>',
  gatling: '<path d="M3 10h8V6h12v3h19v3H23v2h19v3H23v3h-6l-3 6H8l3-9H3zM13 3h8v3h-8zM34 7h3v14h-3z"/>',
};

function toast(message) {
  clearTimeout(state.toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 3800);
}

function selectedWeapon() { return WEAPONS.find((weapon) => weapon.id === state.config.weaponId); }
function setRangeFill(input) { input.style.setProperty('--fill', `${100 * (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min))}%`); }

function fillControls() {
  const config = state.config;
  $('weapon-options').replaceChildren();
  for (const weapon of WEAPONS) {
    const button = document.createElement('button');
    button.className = `weapon-button${weapon.id === config.weaponId ? ' selected' : ''}`;
    button.setAttribute('aria-pressed', String(weapon.id === config.weaponId));
    button.setAttribute('aria-label', `${weaponNames[weapon.id]} 선택`);
    button.innerHTML = `<svg viewBox="0 0 46 30" aria-hidden="true">${weaponIcons[weapon.id]}</svg><span>${weaponNames[weapon.id]}</span><small>${weapon.subtitle}</small>`;
    button.addEventListener('click', () => {
      state.config.weaponId = weapon.id;
      state.config.patch = { damage: Number((weapon.damage * 1.15).toFixed(3)), interval: Number((weapon.interval * 0.9).toFixed(4)), critChance: weapon.critChance };
      fillControls(); markDirty();
    });
    $('weapon-options').append(button);
  }
  $('enemy').value = config.enemyId;
  for (const key of ['damage', 'interval']) {
    const range = $(key);
    // Imports may contain valid engine values outside the compact slider's default window.
    range.max = String(Math.max(key === 'damage' ? selectedWeapon().damage * 4 : selectedWeapon().interval * 3, config.patch[key]));
    range.min = key === 'damage' ? '0.01' : '0.02';
    range.step = 'any';
    range.value = config.patch[key];
    $(`${key}-number`).value = config.patch[key];
    $(`${key}-number`).min = range.min;
    $(`${key}-number`).max = key === 'damage' ? '1000' : '10';
    $(`${key}-number`).step = 'any';
    setRangeFill(range);
  }
  $('crit').step = 'any'; $('crit-number').step = 'any';
  $('crit').value = config.patch.critChance * 100;
  $('crit-number').value = Number((config.patch.critChance * 100).toFixed(8));
  setRangeFill($('crit'));
  const mapping = { 'enemy-hp': config.enemy.hp, 'enemy-damage': config.enemy.damage, 'enemy-interval': config.enemy.interval, 'enemy-count': config.enemy.count, 'enemy-armor': config.enemy.armor, 'squad-size': config.squadSize, 'player-hp': config.playerHp, 'time-limit': config.timeLimit, seed: config.seed };
  for (const [id, value] of Object.entries(mapping)) $(id).value = value;
  if (![...$('trials').options].some((option) => Number(option.value) === config.trials)) {
    const option = document.createElement('option'); option.value = config.trials; option.textContent = `${format(config.trials, 0)}회 · 불러온 설정`; $('trials').append(option);
  }
  $('trials').value = config.trials;
  updateDps();
}

function updateDps() {
  const base = selectedWeapon();
  const patch = state.config.patch;
  $('base-damage').textContent = `원본 ${format(base.damage, 2)}`;
  $('base-interval').textContent = `원본 ${format(base.interval, 3)}초`;
  $('base-crit').textContent = `원본 ${format(base.critChance * 100, 0)}%`;
  $('delta-damage').textContent = `${sign((patch.damage / base.damage - 1) * 100, 0)}%`;
  $('delta-interval').textContent = `${sign((patch.interval / base.interval - 1) * 100, 0)}%`;
  $('delta-crit').textContent = `${sign((patch.critChance - base.critChance) * 100, 0)}pp`;
  const dps = (weapon) => weapon.damage * (1 + weapon.critChance * (base.critMultiplier - 1)) / weapon.interval;
  $('base-dps').textContent = format(dps(base));
  $('patch-dps').textContent = Number.isFinite(dps(patch)) && patch.damage > 0 && patch.interval >= .02 && patch.critChance >= 0 && patch.critChance <= 1 ? format(dps(patch)) : '—';
}

function markDirty() {
  state.dirty = true;
  if (!state.busy) {
    $('run-state').textContent = '설정 변경 · 다시 실행해 주세요';
    $('status-dot').className = 'status-dot dirty';
  }
  updateDps();
}

function runConfigFromInputs() {
  const input = clone(state.config);
  for (const [id, key] of [['enemy-hp', 'hp'], ['enemy-damage', 'damage'], ['enemy-interval', 'interval'], ['enemy-count', 'count'], ['enemy-armor', 'armor']]) input.enemy[key] = $(id).valueAsNumber;
  for (const [id, key] of [['squad-size', 'squadSize'], ['player-hp', 'playerHp'], ['time-limit', 'timeLimit'], ['seed', 'seed']]) input[key] = $(id).valueAsNumber;
  input.trials = Number($('trials').value);
  input.patch = { damage: $('damage-number').valueAsNumber, interval: $('interval-number').valueAsNumber, critChance: $('crit-number').valueAsNumber / 100 };
  return validateConfig(input);
}

function setBusy(busy) {
  state.busy = busy;
  $('results-area').setAttribute('aria-busy', String(busy));
  $('run-button').disabled = busy;
  $('mobile-run-button').disabled = busy;
  $('mobile-run-button').textContent = busy ? '실험 중…' : '▶ 이 설정으로 실험 실행';
  $('run-button').innerHTML = busy ? '<span aria-hidden="true">◌</span> 실험 중…' : '<span aria-hidden="true">▶</span> 실험 실행 <kbd>↵</kbd>';
  $('progress-track').hidden = !busy;
  for (const id of ['save-button', 'json-button', 'csv-button']) $(id).disabled = busy || !state.result;
  if (busy) { $('run-state').textContent = '전투를 반복 실행하고 있습니다'; $('status-dot').className = 'status-dot running'; $('progress-bar').style.width = '0%'; }
}

async function run(configOverride) {
  let config;
  try { config = configOverride ? validateConfig(configOverride) : runConfigFromInputs(); } catch (error) { showError(error.message); return; }
  if (state.worker) { state.worker.terminate(); state.worker = null; }
  const id = ++state.activeId;
  state.config = clone(config); state.dirty = false;
  $('error-box').hidden = true;
  pauseReplay();
  setBusy(true);
  const start = performance.now();
  const complete = (result) => {
    if (id !== state.activeId) return;
    state.result = result;
    state.sequence++;
    setBusy(false);
    renderResults();
    $('run-meta').textContent = `${format(config.trials, 0)}쌍 · ${(performance.now() - start).toFixed(0)}ms · SEED ${config.seed}`;
    $('experiment-id').textContent = `EXP / ${String(state.sequence).padStart(3, '0')}`;
    let unchanged = false;
    try { unchanged = JSON.stringify(runConfigFromInputs()) === JSON.stringify(config); } catch { /* edits are still in progress */ }
    state.dirty = !unchanged;
    $('run-state').textContent = unchanged ? '실험 완료' : '설정 변경 · 결과는 이전 실행 기준';
    $('status-dot').className = unchanged ? 'status-dot' : 'status-dot dirty';
    $('live-status').textContent = `${config.trials}회 실험 완료. 원본 승률 ${percent(result.baseline.winRate)}, 패치 승률 ${percent(result.patch.winRate)}.`;
  };
  const fail = (message) => { if (id === state.activeId) { setBusy(false); showError(message); } };
  let fellBack = false;
  let ownedWorker = null;
  const fallback = async () => {
    if (id !== state.activeId || fellBack) return;
    fellBack = true;
    ownedWorker?.terminate();
    if (state.worker === ownedWorker) state.worker = null;
    try {
      const trials = [];
      for (let index = 0; index < config.trials; index++) {
        if (id !== state.activeId) return;
        trials.push(runTrial(config, index));
        if (index % 25 === 0) { $('progress-bar').style.width = `${100 * index / config.trials}%`; await new Promise((resolve) => setTimeout(resolve, 0)); }
      }
      complete(aggregateResults(config, trials));
    } catch (error) { fail(error.message); }
  };
  try {
    const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    ownedWorker = worker;
    state.worker = worker;
    worker.onmessage = ({ data }) => {
      if (data.id !== state.activeId) return;
      if (data.type === 'progress') $('progress-bar').style.width = `${data.progress * 100}%`;
      else if (data.type === 'complete') { worker.terminate(); if (state.worker === worker) state.worker = null; complete(data.result); }
      else if (data.type === 'error') { worker.terminate(); if (state.worker === worker) state.worker = null; fail(data.message); }
    };
    worker.onerror = (event) => { event.preventDefault(); fallback(); };
    worker.postMessage({ id, config });
  } catch { fallback(); }
}

function showError(message) {
  $('error-box').textContent = message;
  $('error-box').hidden = false;
  $('run-state').textContent = '설정을 확인해 주세요';
  $('status-dot').className = 'status-dot dirty';
  $('error-box').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function renderResults() {
  const { baseline, patch, delta, config } = state.result;
  $('metric-win').innerHTML = `${sign(delta.winRate * 100)}<small>pp</small>`;
  $('metric-win').classList.toggle('negative', delta.winRate < 0);
  $('metric-win-detail').innerHTML = `원본 ${percent(baseline.winRate)} <span class="highlight">→ 패치 ${percent(patch.winRate)}</span>`;
  $('metric-time').innerHTML = `${format(patch.meanDuration, 2)}<small>초</small>`;
  $('metric-time-detail').textContent = `원본 ${format(baseline.meanDuration, 2)}초 대비 ${sign(delta.meanDuration, 2)}초`;
  $('metric-damage').textContent = format(patch.meanDamage, 0);
  $('metric-damage-detail').textContent = `원본 ${format(baseline.meanDamage, 0)} 대비 ${sign(delta.meanDamage, 0)} · 초과 피해 제외`;
  renderWinChart(); renderDistribution();
  const insight = $('insight').querySelector('p');
  const resultWeapon = WEAPONS.find((weapon) => weapon.id === config.weaponId);
  const equal = config.patch.damage === resultWeapon.damage && config.patch.interval === resultWeapon.interval && config.patch.critChance === resultWeapon.critChance;
  if (equal) insight.textContent = '원본과 패치가 같은 수치입니다. 같은 시드에서 두 결과가 일치하는지 확인하세요.';
  else if (Math.abs(delta.winRate) < 0.001) insight.textContent = '이번 조건에서는 승률 변화가 없습니다. 적의 체력·공격력이나 무기 수치를 조정해 보세요.';
  else insight.innerHTML = `패치 후 승률이 <strong>${format(Math.abs(delta.winRate) * 100)}%p ${delta.winRate > 0 ? '높아졌습니다' : '낮아졌습니다'}.</strong> 모델의 관측 결과이며 실제 플레이 검증이 필요합니다.`;
  state.replayTime = 0; $('replay-scrub').value = 0; setRangeFill($('replay-scrub'));
  $('replay-seed').textContent = `SEED ${config.seed}`;
  const label = (battle) => battle.won ? '승리' : battle.remainingHp > 0 ? '시간 초과' : '패배';
  $('replay-summary').innerHTML = `<span>A · ${label(state.result.replay.baseline)} ${format(state.result.replay.baseline.duration, 2)}s</span><span>B · ${label(state.result.replay.patch)} ${format(state.result.replay.patch.duration, 2)}s</span>`;
  drawReplay();
}

function renderWinChart() {
  const { baseline, patch } = state.result;
  const width = 410, left = 55, right = 360, span = right - left;
  let svg = `<svg viewBox="0 0 ${width} 150" role="presentation">`;
  for (let value = 0; value <= 100; value += 25) { const x = left + span * value / 100; svg += `<line class="chart-grid" x1="${x}" y1="7" x2="${x}" y2="115"/><text class="chart-number" x="${x}" y="137" text-anchor="middle">${value}%</text>`; }
  for (const [index, item, color, label] of [[0, baseline, '#8796ab', 'A 원본'], [1, patch, '#b9ed6b', 'B 패치']]) {
    const y = 27 + index * 56, x = left + item.winRate * span, lo = left + item.ci[0] * span, hi = left + item.ci[1] * span;
    svg += `<text class="chart-label" x="0" y="${y + 5}">${label}</text><rect x="${left}" y="${y - 12}" width="${span}" height="24" rx="3" fill="#242d20"/><rect x="${left}" y="${y - 12}" width="${Math.max(0, item.winRate * span)}" height="24" rx="3" fill="${color}" opacity="${index ? '.9' : '.55'}"/><line class="ci-line" x1="${lo}" y1="${y}" x2="${hi}" y2="${y}"/><path class="ci-line" d="M${lo} ${y - 5}v10M${hi} ${y - 5}v10"/><text x="${right + 7}" y="${y + 4}" style="fill:${color};font:10px 'IBM Plex Mono',monospace">${format(item.winRate * 100)}%</text>`;
  }
  $('win-chart').innerHTML = svg + '</svg>';
  $('win-chart').setAttribute('aria-label', `원본 승률 ${percent(baseline.winRate)}, 95% 구간 ${percent(baseline.ci[0])}~${percent(baseline.ci[1])}. 패치 ${percent(patch.winRate)}, 구간 ${percent(patch.ci[0])}~${percent(patch.ci[1])}.`);
}

function renderDistribution() {
  if (!state.result) return;
  const { baseline, patch, config } = state.result;
  const width = Math.max(275, $('distribution-chart').clientWidth - 36), height = 180, left = 35, right = width - 18, top = 12, bottom = 147;
  const plotWidth = right - left, plotHeight = bottom - top;
  const maxDuration = Math.max(...baseline.durations, ...patch.durations);
  const timeEnd = Math.min(config.timeLimit, Math.max(1, Math.ceil(maxDuration * 1.15)));
  let svg = `<svg viewBox="0 0 ${width} ${height}" role="presentation">`;
  if (state.graph === 'survival') {
    $('distribution-description').textContent = '경과 시간별 살아 있는 분대의 비율 · 승리한 분대는 생존으로 유지';
    for (let value = 0; value <= 100; value += 25) {
      const y = bottom - plotHeight * value / 100;
      svg += `<line class="chart-grid" x1="${left}" y1="${y}" x2="${right}" y2="${y}"/><text class="chart-number" x="${left - 8}" y="${y + 3}" text-anchor="end">${value}%</text>`;
    }
    for (const [item, color, opacity] of [[baseline, '#8796ab', '.06'], [patch, '#b9ed6b', '.09']]) {
      const points = item.survival.filter((point) => point.time <= timeEnd);
      const last = points.at(-1);
      if (last.time < timeEnd) points.push({ time: timeEnd, rate: last.rate });
      let path = `M${left} ${bottom - points[0].rate * plotHeight}`;
      points.slice(1).forEach((point) => { const x = left + point.time / timeEnd * plotWidth, y = bottom - point.rate * plotHeight; path += `H${x}V${y}`; });
      svg += `<path d="${path}L${left + points.at(-1).time / timeEnd * plotWidth} ${bottom}H${left}Z" fill="${color}" opacity="${opacity}"/><path d="${path}" fill="none" stroke="${color}" stroke-width="2"/>`;
    }
    $('distribution-chart').setAttribute('aria-label', `생존율 차트. 종료 시 원본 ${percent(baseline.survival.at(-1).rate)}, 패치 ${percent(patch.survival.at(-1).rate)}. 승리와 체력이 남은 시간초과는 생존으로 집계합니다.`);
  } else {
    $('distribution-description').textContent = '전투 종료 시간별 횟수 · 승리, 패배, 시간 초과를 모두 포함';
    const bins = 14;
    const counts = [baseline, patch].map((item) => { const values = new Array(bins).fill(0); item.durations.forEach((duration) => { values[Math.min(bins - 1, Math.floor(duration / timeEnd * bins))]++; }); return values; });
    const max = Math.max(...counts.flat(), 1);
    for (let part = 0; part <= 4; part++) { const y = bottom - part / 4 * plotHeight; svg += `<line class="chart-grid" x1="${left}" y1="${y}" x2="${right}" y2="${y}"/><text class="chart-number" x="${left - 8}" y="${y + 3}" text-anchor="end">${Math.round(max * part / 4)}</text>`; }
    const binWidth = plotWidth / bins;
    counts.forEach((values, index) => values.forEach((count, bin) => { const barHeight = count / max * plotHeight; svg += `<rect x="${left + bin * binWidth + 4 + index * (binWidth / 2 - 3)}" y="${bottom - barHeight}" width="${binWidth / 2 - 5}" height="${barHeight}" rx="2" fill="${index ? '#b9ed6b' : '#8796ab'}" opacity="${index ? '.85' : '.55'}"><title>${index ? '패치' : '원본'} ${format(bin / bins * timeEnd)}~${format((bin + 1) / bins * timeEnd)}초: ${count}회</title></rect>`; }));
    $('distribution-chart').setAttribute('aria-label', `종료 시간 분포. 원본 평균 ${format(baseline.meanDuration, 2)}초, 패치 평균 ${format(patch.meanDuration, 2)}초. 두 종류 각각 ${config.trials}회.`);
  }
  for (let part = 0; part <= 6; part++) { const x = left + plotWidth * part / 6; svg += `<text class="chart-number" x="${x}" y="171" text-anchor="middle">${format(timeEnd * part / 6, 1)}s</text>`; }
  $('distribution-chart').innerHTML = svg + '</svg>';
}

function maxReplayTime() { return state.result ? Math.max(state.result.replay.baseline.duration, state.result.replay.patch.duration) : 1; }
function frameAt(battle, time) {
  let lo = 0, hi = battle.timeline.length - 1;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (battle.timeline[mid].time <= time + 1e-9) lo = mid; else hi = mid - 1; }
  return battle.timeline[lo];
}

function drawReplay() {
  if (!state.result) return;
  const canvas = $('arena'), ctx = canvas.getContext('2d');
  const width = 680, height = 300;
  if (canvas.height !== height) canvas.height = height;
  ctx.clearRect(0, 0, width, height); ctx.fillStyle = '#121a10'; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#283321'; ctx.lineWidth = 1;
  for (let x = 0; x < width; x += 28) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); }
  for (let y = 0; y < height; y += 28) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke(); }
  ctx.fillStyle = '#121a10bb'; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = '#35402c'; ctx.setLineDash([4, 6]); ctx.beginPath(); ctx.moveTo(15, 150); ctx.lineTo(width - 15, 150); ctx.stroke(); ctx.setLineDash([]);
  const { replay, config } = state.result;
  for (const [index, key, color, label] of [[0, 'baseline', '#8796ab', 'A / ORIGINAL'], [1, 'patch', '#b9ed6b', 'B / PATCH']]) {
    const battle = replay[key], frame = frameAt(battle, state.replayTime), y = 77 + index * 150;
    ctx.font = '11px monospace'; ctx.fillStyle = color; ctx.fillText(label, 20, y - 47);
    const ratio = frame.playerHp / config.playerHp;
    ctx.fillStyle = '#303c29'; ctx.fillRect(20, y + 42, 143, 4); ctx.fillStyle = ratio > .3 ? color : '#e99583'; ctx.fillRect(20, y + 42, 143 * ratio, 4);
    ctx.font = '10px monospace'; ctx.fillStyle = '#a7b59b'; ctx.fillText(`HP ${Math.ceil(frame.playerHp)} / ${config.playerHp}`, 20, y + 33);
    const visibleTroops = Math.min(config.squadSize, 12);
    for (let unit = 0; unit < visibleTroops; unit++) {
      const x = 34 + unit % 4 * 20, py = y - 13 + Math.floor(unit / 4) * 13;
      ctx.fillStyle = frame.playerHp > 0 ? color : '#414a3b'; ctx.beginPath(); ctx.arc(x, py - 4, 3, 0, Math.PI * 2); ctx.fill(); ctx.fillRect(x - 4, py, 8, 7); ctx.fillRect(x + 3, py + 1, 9, 2);
    }
    const finished = state.replayTime >= battle.duration;
    let lastShotTime = -Infinity;
    let previousShots = 0;
    for (const event of battle.timeline) {
      if (event.time > state.replayTime + 1e-9) break;
      if (event.shots > previousShots) lastShotTime = event.time;
      previousShots = event.shots;
    }
    const shooting = !finished && state.replayTime - lastShotTime < .09;
    if (shooting) {
      ctx.strokeStyle = color; ctx.globalAlpha = .65; ctx.lineWidth = 1.5;
      for (let line = 0; line < 3; line++) { ctx.beginPath(); ctx.moveTo(129, y - 8 + line * 12); ctx.lineTo(435, y + 2); ctx.stroke(); }
      ctx.globalAlpha = 1;
    }
    const groupStart = Math.floor(Math.min(frame.kills, config.enemy.count - 1) / 8) * 8;
    for (let enemyIndex = 0; enemyIndex < Math.min(config.enemy.count - groupStart, 8); enemyIndex++) {
      const x = 460 + enemyIndex % 4 * 32, py = y - 13 + Math.floor(enemyIndex / 4) * 30;
      const targetIndex = groupStart + enemyIndex;
      const dead = targetIndex < frame.kills;
      ctx.fillStyle = dead ? '#34402c' : targetIndex === frame.kills ? '#eaa47c' : '#6f7958';
      if (config.enemyId === 'boss') { ctx.fillRect(x - 3, py - 2, 23, 23); ctx.fillRect(x + 3, py - 10, 11, 8); }
      else { ctx.beginPath(); ctx.moveTo(x, py - 7); ctx.lineTo(x + 8, py - 1); ctx.lineTo(x + 6, py + 10); ctx.lineTo(x - 6, py + 10); ctx.lineTo(x - 8, py - 1); ctx.closePath(); ctx.fill(); }
      if (dead) { ctx.strokeStyle = '#758368'; ctx.beginPath(); ctx.moveTo(x - 4, py - 4); ctx.lineTo(x + 4, py + 4); ctx.moveTo(x + 4, py - 4); ctx.lineTo(x - 4, py + 4); ctx.stroke(); }
    }
    ctx.fillStyle = '#9ba98e'; ctx.font = '10px monospace'; ctx.fillText(`${frame.kills} / ${config.enemy.count} CLEARED`, 444, y + 38);
    ctx.fillStyle = color; ctx.font = '12px monospace'; ctx.fillText(`DMG ${Math.round(frame.damageDealt)}`, 223, y + 35);
    if (finished) { ctx.fillStyle = battle.won ? '#c1ee87' : '#eba38e'; ctx.font = 'bold 16px monospace'; ctx.fillText(battle.won ? 'CLEAR' : battle.remainingHp > 0 ? 'TIMEOUT' : 'DEFEAT', 237, y + 3); }
    else { ctx.fillStyle = '#627452'; ctx.font = '10px monospace'; ctx.fillText('ENGAGING', 231, y - 23); }
  }
  $('replay-time').textContent = `${state.replayTime.toFixed(1).padStart(4, '0')}s`;
  $('arena').setAttribute('aria-label', `${format(state.replayTime)}초 리플레이. 원본 잔여 체력 ${format(frameAt(replay.baseline, state.replayTime).playerHp, 0)}, 패치 잔여 체력 ${format(frameAt(replay.patch, state.replayTime).playerHp, 0)}.`);
}

function pauseReplay() { state.playing = false; $('play-button').textContent = '▶'; $('play-button').setAttribute('aria-label', '리플레이 재생'); }
function replayLoop(timestamp) {
  if (!state.playing) return;
  if (state.lastFrame) state.replayTime = Math.min(maxReplayTime(), state.replayTime + Math.min((timestamp - state.lastFrame) / 1000, .1) * Number($('replay-speed').value));
  state.lastFrame = timestamp;
  $('replay-scrub').value = 1000 * state.replayTime / maxReplayTime(); setRangeFill($('replay-scrub')); drawReplay();
  if (state.replayTime >= maxReplayTime()) pauseReplay();
  else requestAnimationFrame(replayLoop);
}

function renderHistory() {
  $('history-count').textContent = state.history.length;
  $('saved-count').textContent = state.history.length;
  const list = $('history-list'); list.replaceChildren();
  if (!state.history.length) { list.innerHTML = '<div class="empty-history"><span aria-hidden="true">▤</span><div><strong>첫 번째 실험을 남겨 보세요.</strong><p>설정과 시드를 저장하면, 언제든 같은 결과를 다시 확인할 수 있습니다.</p></div></div>'; return; }
  for (const item of state.history) {
    const row = document.createElement('div'); row.className = 'history-row';
    const info = document.createElement('div');
    const title = document.createElement('div'); title.className = 'history-row-title'; title.textContent = `${weaponNames[item.config.weaponId]} / ${enemyNames[item.config.enemyId].split(' · ')[0]}`;
    const meta = document.createElement('div'); meta.className = 'history-row-meta'; meta.textContent = `${new Date(item.createdAt).toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })} · ${item.config.trials}회 · SEED ${item.config.seed}`;
    info.append(title, meta);
    const delta = document.createElement('div'); delta.className = 'history-win'; delta.textContent = `${sign(item.winDelta * 100)}pp`; const caption = document.createElement('small'); caption.textContent = '승률 변화'; delta.append(caption);
    const load = document.createElement('button'); load.textContent = '재실행 ↗'; load.setAttribute('aria-label', `${title.textContent} 시드 ${item.config.seed} 재실행`); load.addEventListener('click', () => { state.config = clone(item.config); fillControls(); run(item.config); $('main').scrollIntoView({ behavior: 'smooth' }); });
    const remove = document.createElement('button'); remove.textContent = '삭제'; remove.className = 'delete-history'; remove.setAttribute('aria-label', `${title.textContent} 시드 ${item.config.seed} 기록 삭제`); remove.addEventListener('click', () => { const next = state.history.filter((entry) => entry.id !== item.id); if (persistHistory(next)) toast('이 브라우저에서 기록을 삭제했습니다.'); });
    row.append(info, delta, load, remove); list.append(row);
  }
}

function persistHistory(next) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(next)); state.history = next; renderHistory(); return true; }
  catch { toast('브라우저 저장 공간을 사용할 수 없습니다. JSON으로 내보내 주세요.'); return false; }
}

function download(name, content, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function setup() {
  for (const enemy of ENEMIES) { const option = document.createElement('option'); option.value = enemy.id; option.textContent = enemyNames[enemy.id]; $('enemy').append(option); }
  $('enemy-damage').max = '1000'; $('time-limit').max = '180';
  for (const key of ['damage', 'interval', 'crit']) {
    const update = (source) => {
      const value = source.valueAsNumber;
      if (!Number.isFinite(value)) { state.config.patch[key === 'crit' ? 'critChance' : key] = NaN; markDirty(); return; }
      if (source.type === 'range') { const rounded = key === 'damage' ? Math.round(value * 100) / 100 : key === 'interval' ? Math.round(value * 1000) / 1000 : Math.round(value); $(`${key}-number`).value = rounded; source.value = rounded; }
      else { if (key !== 'crit') $(key).max = Math.max(Number($(key).max), value); $(key).value = value; }
      state.config.patch[key === 'crit' ? 'critChance' : key] = $(`${key}-number`).valueAsNumber / (key === 'crit' ? 100 : 1);
      setRangeFill($(key)); markDirty();
    };
    $(key).addEventListener('input', () => update($(key)));
    $(`${key}-number`).addEventListener('input', () => update($(`${key}-number`)));
  }
  $('enemy').addEventListener('change', () => { const preset = ENEMIES.find((enemy) => enemy.id === $('enemy').value); state.config.enemyId = preset.id; state.config.enemy = { hp: preset.hp, damage: preset.damage, interval: preset.interval, count: preset.count, armor: preset.armor }; fillControls(); markDirty(); });
  for (const id of ['enemy-hp', 'enemy-damage', 'enemy-interval', 'enemy-count', 'enemy-armor', 'squad-size', 'player-hp', 'time-limit', 'trials', 'seed']) $(id).addEventListener('input', () => { try { state.config = runConfigFromInputs(); } catch { /* Validation feedback is shown on Run. */ } markDirty(); });
  $('run-button').addEventListener('click', () => run());
  $('mobile-run-button').addEventListener('click', () => { run(); $('results-area').scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  $('reset-button').addEventListener('click', () => { state.config = clone(DEFAULT_CONFIG); fillControls(); markDirty(); toast('설정을 기본 실험으로 되돌렸습니다.'); });
  $('equalize-button').addEventListener('click', () => { const base = selectedWeapon(); state.config.patch = { damage: base.damage, interval: base.interval, critChance: base.critChance }; fillControls(); markDirty(); });
  $('survival-tab').addEventListener('click', () => setGraph('survival'));
  $('duration-tab').addEventListener('click', () => setGraph('duration'));
  $('play-button').addEventListener('click', () => {
    if (!state.result) return;
    if (state.playing) { pauseReplay(); return; }
    if (state.replayTime >= maxReplayTime()) state.replayTime = 0;
    state.playing = true; state.lastFrame = 0; $('play-button').textContent = 'Ⅱ'; $('play-button').setAttribute('aria-label', '리플레이 일시 정지'); requestAnimationFrame(replayLoop);
  });
  $('replay-scrub').addEventListener('input', () => { pauseReplay(); state.replayTime = Number($('replay-scrub').value) / 1000 * maxReplayTime(); setRangeFill($('replay-scrub')); drawReplay(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pauseReplay(); });
  $('save-button').addEventListener('click', () => {
    if (!state.result || state.busy) return;
    const same = state.history.find((item) => JSON.stringify(item.config) === JSON.stringify(state.result.config));
    if (same) { toast('같은 설정과 시드의 실험이 이미 저장되어 있습니다.'); return; }
    const record = historyRecord(state.result, `${Date.now()}-${state.sequence}`);
    if (persistHistory([record, ...state.history].slice(0, 20))) toast(state.dirty ? '화면에 표시된 이전 실행 결과를 저장했습니다.' : '실험을 저장했습니다. 최대 20개까지 보관됩니다.');
  });
  $('json-button').addEventListener('click', () => { if (state.result) { download(`balance-lab-${state.result.config.seed}.json`, serializeExperiment(state.result), 'application/json'); toast('실험 설정과 결과를 JSON으로 내보냈습니다.'); } });
  $('csv-button').addEventListener('click', () => { if (state.result) { const baselineWeapon = WEAPONS.find((weapon) => weapon.id === state.result.config.weaponId); download(`balance-lab-${state.result.config.seed}.csv`, resultCsv({ ...state.result, baselineWeapon }), 'text/csv;charset=utf-8'); toast('원본·패치 요약을 CSV로 내보냈습니다.'); } });
  $('import-button').addEventListener('click', () => $('import-file').click());
  $('import-file').addEventListener('change', async (event) => {
    const file = event.target.files[0]; if (!file) return;
    try { if (file.size > MAX_IMPORT_BYTES) throw new Error('2MB 이하의 JSON 파일만 불러올 수 있습니다.'); const config = parseExperiment(await file.text()); state.config = config; fillControls(); run(config); toast('설정을 불러왔습니다. 결과를 다시 계산합니다.'); }
    catch (error) { showError(error.message); }
    finally { event.target.value = ''; }
  });
  $('model-open').addEventListener('click', () => $('model-dialog').showModal());
  $('model-close').addEventListener('click', () => $('model-dialog').close());
  $('model-dialog').addEventListener('click', (event) => { if (event.target === $('model-dialog')) { const rect = $('model-dialog').getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $('model-dialog').close(); } });
  document.addEventListener('keydown', (event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !$('model-dialog').open && !state.busy) { event.preventDefault(); run(); } });
  $('run-button').title = '실험 실행 (Ctrl/⌘ + Enter)';
  const chartObserver = new ResizeObserver(() => renderDistribution());
  chartObserver.observe($('distribution-chart'));
  try { state.history = readHistory(localStorage); } catch { toast('저장된 기록을 읽지 못했습니다. JSON 파일로 불러올 수 있습니다.'); }
  fillControls(); renderHistory(); setBusy(false); run();
}

function setGraph(graph) {
  state.graph = graph;
  for (const key of ['survival', 'duration']) { $(`${key}-tab`).classList.toggle('selected', key === graph); $(`${key}-tab`).setAttribute('aria-pressed', String(key === graph)); }
  renderDistribution();
}

setup();
