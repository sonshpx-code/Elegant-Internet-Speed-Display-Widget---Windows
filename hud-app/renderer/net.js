'use strict';

/**
 * DSH Net HUD —— 渲染端。
 *
 * 网速每秒都在变，所以这里最容易退化成“每秒重画整卡”，而那就是“组件在闪”的来源。
 * 纪律只有一条：**内容签名不变就一个字节都不写 DOM**。数字按四舍五入后的字符串比对，
 * 单位跳变（KB/s → MB/s）才算变化；只有真的写过 DOM 才重放那 240ms 的淡入。
 *
 * `window.__netStats()` 把这件事变成可断言的量：连着采两次，`frames` 涨而
 * `writes` 不涨，就说明“收帧”和“重画”是分开的。闪烁回归靠它而不是靠眼睛。
 */

const stage = document.getElementById('stage');
const canvas = document.getElementById('spark');
const note = document.getElementById('note');
const rxValue = document.getElementById('rx-value');
const rxUnit = document.getElementById('rx-unit');
const txValue = document.getElementById('tx-value');
const txUnit = document.getElementById('tx-unit');
const rowDown = document.querySelector('.row[data-dir="down"]');
const rowUp = document.querySelector('.row[data-dir="up"]');

const HISTORY = 48;            // 采样点数量：1 秒一个点 ≈ 最近 48 秒
const SPARK_H = 26;            // 走势带高度（基础像素）
const ACTIVE_FLOOR = 1024;     // 每秒 1KB 以上才算“这个方向在动”
const ACTIVE_ON = 2048;
const ACTIVE_OFF = 1024;

let shell = { theme: 'dark', unit: 'bytes', lang: 'zh', scale: 1, sparkline: true, baseW: 168, baseH: 68, animation: 'standard' };
let prefs = {};
let history = [];              // [[down, up], ...]，均以 字节/秒 计
let lastSampleAt = 0;
let intervalMs = 1000;
let samplerOk = true;
let downActive = false;
let upActive = false;
let lastRaw = null;
let lastAura = { down: -1, up: -1 };
let colors = { down: '#34D399', up: '#60A5FA' };
let frames = 0;
let writes = 0;
let churnWindowStart = Date.now();
let churnInWindow = 0;
const bootedAt = Date.now();

/* --------------------------------------------------------------- 工具 */

/** 界面文案：字典由 ../i18n.js 挂在 window 上（和主进程共用同一份）。 */
function t(key) {
  const dict = window.NET_HUD_I18N ?? {};
  const table = dict[shell.lang] ?? dict.zh ?? {};
  const text = table[key];
  return typeof text === 'string' ? text : key;
}

function noteWrite() {
  writes += 1;
  churnInWindow += 1;
  const elapsed = Date.now() - churnWindowStart;
  if (elapsed < 5000) return;
  const rate = churnInWindow / (elapsed / 1000);
  // 阈值 14/s：正常有流量时是「数值+单位+档位+光晕 ≈ 6/s」再加呼吸 4/s。
  // 超过这个数就说明有东西在无效重写 DOM（这条探针抓到过好几回）。
  if (rate > 14) console.warn(`[net-hud] render churn: ${churnInWindow} writes in ${(elapsed / 1000).toFixed(1)}s (${rate.toFixed(1)}/s)`);
  churnInWindow = 0;
  churnWindowStart = Date.now();
}

function replay(el, className, ms) {
  el.classList.remove(className);
  void el.offsetWidth;          // 强制样式刷新，类才能重开动画
  el.classList.add(className);
  if (el._replayTimer) clearTimeout(el._replayTimer);
  el._replayTimer = setTimeout(() => el.classList.remove(className), ms);
}

function setText(el, text) {
  if (el.textContent === text) return;      // 签名相同：一个字节都不写
  el.textContent = text;
  noteWrite();
}

function setValueText(el, text) {
  if (el.textContent === text) return;
  el.textContent = text;
  noteWrite();
  replay(el, 'ticked', 260);
}

function setAttr(el, name, value) {
  if (el.getAttribute(name) === value) return;
  el.setAttribute(name, value);
  noteWrite();
}

/* --------------------------------------------------------------- 数值 */

/** 与任务管理器/宽带标称两套口径：B/s 与 bit/s。 */
function formatSpeed(bytesPerSecond, unit) {
  const bits = unit === 'bits';
  let value = bits ? bytesPerSecond * 8 : bytesPerSecond;
  if (!Number.isFinite(value) || value < 0) value = 0;
  const units = bits ? ['b/s', 'Kb/s', 'Mb/s', 'Gb/s'] : ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  let text;
  if (index === 0) text = String(Math.round(value));
  else if (value < 10) text = value.toFixed(2);
  else if (value < 100) text = value.toFixed(1);
  else text = String(Math.round(value));
  // tier 就是单位档位（0=B/s 1=KB/s 2=MB/s 3=GB/s）：CSS 用它把「快慢」直接画在单位上
  return { value: text, unit: units[index], tier: index };
}

/** 活动度 → 光晕强度：对数刻度，1MB/s 以上就拉满。 */
function activityLevel(bytesPerSecond) {
  const level = Math.log10(1 + Math.max(0, bytesPerSecond) / 1024) / 3;
  return Math.max(0.16, Math.min(1, level));
}

function applyAura(down, up) {
  const d = Number(activityLevel(down).toFixed(3));
  const u = Number(activityLevel(up).toFixed(3));
  if (Math.abs(d - lastAura.down) > 0.01) {
    stage.style.setProperty('--down-level', String(d));
    lastAura.down = d;
  }
  if (Math.abs(u - lastAura.up) > 0.01) {
    stage.style.setProperty('--up-level', String(u));
    lastAura.up = u;
  }
}

/* --------------------------------------------------------------- 走势 */

function readColors() {
  const cs = getComputedStyle(stage);
  const down = cs.getPropertyValue('--down').trim();
  const up = cs.getPropertyValue('--up').trim();
  if (down !== '') colors.down = down;
  if (up !== '') colors.up = up;
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const scale = Number(shell.scale) || 1;
  const width = Math.max(1, Math.round(shell.baseW * scale * dpr));
  const height = Math.max(1, Math.round(SPARK_H * scale * dpr));
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  canvas.style.width = `${shell.baseW}px`;
  canvas.style.height = `${SPARK_H}px`;
}

function drawSpark() {
  const dpr = window.devicePixelRatio || 1;
  const scale = Number(shell.scale) || 1;
  const k = scale * dpr;
  const width = shell.baseW;
  const height = SPARK_H;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(k, 0, 0, k, 0, 0);
  ctx.clearRect(0, 0, width, height);
  if (history.length < 2) return;

  let max = 1024;
  for (const [down, up] of history) max = Math.max(max, down, up);

  const step = width / (HISTORY - 1);
  // 最新的点贴右边：历史不足时从右侧开始铺
  const offset = width - (history.length - 1) * step;
  const y = (value) => height - 2 - (Math.min(value, max) / max) * (height - 5);

  // 下行：面积 + 描边
  ctx.beginPath();
  ctx.moveTo(offset, height);
  history.forEach(([down], index) => ctx.lineTo(offset + index * step, y(down)));
  ctx.lineTo(offset + (history.length - 1) * step, height);
  ctx.closePath();
  const gradient = ctx.createLinearGradient(0, 0, 0, height);
  gradient.addColorStop(0, colors.down);
  gradient.addColorStop(1, 'transparent');
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.globalAlpha = 0.62;
  ctx.strokeStyle = colors.down;
  ctx.lineWidth = 1.1;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  history.forEach(([down], index) => {
    const px = offset + index * step;
    const py = y(down);
    if (index === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.stroke();

  // 上行：只描边，不抢下行的视觉
  ctx.globalAlpha = 0.38;
  ctx.strokeStyle = colors.up;
  ctx.lineWidth = 1;
  ctx.beginPath();
  history.forEach(([, up], index) => {
    const px = offset + index * step;
    const py = y(up);
    if (index === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
  });
  ctx.stroke();

  // 峰值点：让人一眼知道这段时间最快到过多少
  let peakIndex = 0;
  history.forEach(([down], index) => { if (down > history[peakIndex][0]) peakIndex = index; });
  if (history[peakIndex][0] > 0) {
    ctx.globalAlpha = 0.8;
    ctx.fillStyle = colors.down;
    ctx.beginPath();
    ctx.arc(offset + peakIndex * step, y(history[peakIndex][0]), 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/* --------------------------------------------------------------- 状态 */

function setNote(text) {
  if (text === null || text === '') {
    if (!note.hidden) { note.hidden = true; note.textContent = ''; noteWrite(); }
    return;
  }
  if (note.hidden || note.textContent !== text) {
    note.textContent = text;
    note.hidden = false;
    replay(note, 'note-in', 320);
    noteWrite();
  }
}

function applyLinkState() {
  let link;
  if (!samplerOk) link = 'offline';
  else if (lastSampleAt === 0) link = 'connecting';
  else if (Date.now() - lastSampleAt > Math.max(3000, intervalMs * 3)) link = 'stale';
  else link = (downActive || upActive) ? 'live' : 'idle';
  setAttr(stage, 'data-link', link);

  if (link === 'offline') setNote(t('samplerNotRunning'));
  else if (link === 'stale') setNote(t('samplerStopped'));
  else if (link === 'connecting') setNote(t('connecting'));
  else setNote('');
}

function applySample(sample) {
  frames += 1;
  const unit = shell.unit;

  const down = sample === null ? 0 : Number(sample.rx) || 0;
  const up = sample === null ? 0 : Number(sample.tx) || 0;

  const downText = formatSpeed(down, unit);
  const upText = formatSpeed(up, unit);
  setValueText(rxValue, downText.value);
  setText(rxUnit, downText.unit);
  setAttr(rxUnit, 'data-tier', String(downText.tier));
  setValueText(txValue, upText.value);
  setText(txUnit, upText.unit);
  setAttr(txUnit, 'data-tier', String(upText.tier));

  // 箭头只在“这个方向真的在动”时亮起并呼吸，迟滞避免在阈值上抖动
  if (!downActive && down >= ACTIVE_ON) downActive = true;
  else if (downActive && down < ACTIVE_OFF) downActive = false;
  if (!upActive && up >= ACTIVE_ON) upActive = true;
  else if (upActive && up < ACTIVE_OFF) upActive = false;
  setAttr(rowDown, 'data-active', downActive ? '1' : '0');
  setAttr(rowUp, 'data-active', upActive ? '1' : '0');
  updateBreath();

  applyAura(down, up);

  if (sample !== null) {
    lastRaw = { rx: down, tx: up, at: Date.now(), ifaces: Array.isArray(sample.ifaces) ? sample.ifaces.length : 0 };
    history.push([down, up]);
    while (history.length > HISTORY) history.shift();
    lastSampleAt = Date.now();
    samplerOk = true;
    if (shell.sparkline) drawSpark();
  }
  applyLinkState();
}

/* --------------------------------------------------------------- 呼吸 */

/*
 * 箭头呼吸：JS 每 260ms 推一步 --breath（约 2 秒一个来回），没有流量时定时器直接停掉。
 *
 * 为什么不用 CSS 无限动画：这台机器走软件合成，无限动画会让合成器一直 60fps 重绘整个
 * 透明窗口。实测（tools/measure.ps1）：带无限动画时渲染 + gpu 进程约 18% 单核，
 * 换成这个 4Hz 的驱动后降到个位数百分比，观感几乎一样。
 */
const BREATH_STEP_MS = 260;
const BREATH_STEPS = 8;          // 8 步 × 260ms ≈ 2.1 秒一个来回
let breathTimer = null;
let breathStep = 0;

function updateBreath() {
  const active = downActive || upActive;
  if (!active) {
    if (breathTimer !== null) { clearInterval(breathTimer); breathTimer = null; }
    if (breathStep !== 0) {
      breathStep = 0;
      stage.style.setProperty('--breath', '0');
      noteWrite();
    }
    return;
  }
  if (breathTimer !== null) return;
  breathTimer = setInterval(() => {
    breathStep = (breathStep + 1) % BREATH_STEPS;
    // 余弦波：0 → 1 → 0，首尾相接不会跳
    const wave = (1 - Math.cos((2 * Math.PI * breathStep) / BREATH_STEPS)) / 2;
    stage.style.setProperty('--breath', wave.toFixed(3));
    noteWrite();
  }, BREATH_STEP_MS);
}

/* --------------------------------------------------------------- 命令 */

function applyShell(next) {
  shell = { ...shell, ...next };
  stage.dataset.theme = shell.theme === 'light' ? 'light' : 'dark';
  stage.dataset.animation = shell.animation ?? 'standard';
  stage.dataset.sparkline = shell.sparkline === false ? 'off' : 'on';
  document.title = t('appName');
  card.setAttribute('aria-label', t('aria'));
  // zoom 是唯一的缩放乘数：主进程用同一个数设窗口尺寸，所以文字和窗口不会错位
  document.documentElement.style.zoom = String(shell.scale ?? 1);
  intervalMs = Number(shell.intervalMs) || intervalMs;
  readColors();
  resizeCanvas();
  if (shell.sparkline) drawSpark();
  else {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

window.netHud.onCommand((command) => {
  if (command === null || typeof command !== 'object') return;
  if (command.type === 'shell') { applyShell(command.shell ?? {}); return; }
  if (command.type === 'sample') {
    if (command.samplerOk === false) samplerOk = false;
    if (command.intervalMs) intervalMs = Number(command.intervalMs) || intervalMs;
    applySample(command.sample ?? null);
    return;
  }
  if (command.type === 'error') {
    samplerOk = false;
    setNote(String(command.message ?? t('samplerNotRunning')));
    applyLinkState();
    return;
  }
  if (command.type === 'pointer') {
    setAttr(stage, 'data-hover', command.over === true ? '1' : '0');
    return;
  }
  if (command.type === 'dragging') {
    setAttr(stage, 'data-dragging', command.on === true ? '1' : '0');
    return;
  }
});

/* --------------------------------------------------------------- 交互 */

/*
 * 拖动只有意图、没有几何：位置和吸附全在主进程手里。
 * move / up / cancel 一律挂在 window 的捕获阶段——手势进行中如果元素被换掉，
 * 元素自己的 pointerup 就再也不会触发，主进程的 dragging 会永远为真。
 */
let pointerDown = false;
let moved = false;
let origin = { x: 0, y: 0 };

window.addEventListener('pointerdown', (event) => {
  if (event.button !== 0) return;
  pointerDown = true;
  moved = false;
  origin = { x: event.screenX, y: event.screenY };
  window.netHud.dragStart();
  event.preventDefault();
}, true);

window.addEventListener('pointermove', (event) => {
  if (!pointerDown) return;
  if (Math.abs(event.screenX - origin.x) + Math.abs(event.screenY - origin.y) > 3) moved = true;
}, true);

function endPointer() {
  if (!pointerDown) return;
  pointerDown = false;
  window.netHud.dragEnd(moved);
}
window.addEventListener('pointerup', endPointer, true);
window.addEventListener('pointercancel', endPointer, true);
window.addEventListener('blur', endPointer, true);

window.addEventListener('contextmenu', (event) => {
  event.preventDefault();
  window.netHud.menu();
});

// 停滞看门狗：采样器安静了就把卡片标成 stale，而不是继续显示旧数字
setInterval(applyLinkState, 700);

// 每 10 分钟重画一次背景（主题切换后渐变缓存不会自己失效）
setInterval(() => { if (shell.sparkline) drawSpark(); }, 600000);

window.addEventListener('resize', () => { resizeCanvas(); if (shell.sparkline) drawSpark(); });

/* --------------------------------------------------- 验证用统计（可断言） */

window.__netStats = () => ({
  frames,                                     // 收到的样本帧数
  writes,                                     // 累计 DOM 文本/属性写入次数
  history: history.length,
  link: stage.dataset.link,
  hover: stage.dataset.hover ?? '0',
  unit: shell.unit,
  scale: shell.scale,
  theme: stage.dataset.theme,
  sparkline: shell.sparkline !== false,
  elapsedMs: Date.now() - bootedAt,
  lastRaw,                                    // 最后一帧的原始字节/秒（排查数值来源用）
  shownDown: rxValue.textContent,
  shownUp: txValue.textContent,
});

window.netHud.ready();
