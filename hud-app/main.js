'use strict';

/**
 * Net HUD —— 常驻桌面网速挂件（窗口半边）。
 *
 * 一个无边框、真透明、始终置顶、**永不抢焦点**的小卡片，贴着屏幕边缘悬浮，
 * 显示实时网速（↓ 下载 / ↑ 上传）。
 *
 * 它是**常驻**的，不挂在任何宿主进程上：登录自启与崩溃自愈由系统计划任务负责
 * （见 tools/install.ps1），所以 DSH 开不开都一样在。DSH 插件那半边是可选项，
 * 只负责在你开着 DSH 时也能从插件面板里启停它。
 *
 * 三条硬指标都只能由窗口这一层保证：
 *
 *   - **不抢焦点**：`focusable: false` 在 Windows 上就是 `WS_EX_NOACTIVATE`，
 *     每次显示都用 `showInactive()`。点卡片不会把组件、也不会把后面的窗口拉到前台。
 *   - **透明像素不是死区**：透明 Electron 窗口在完全透明的像素上照样吃鼠标，
 *     所以每 80 ms 读一次光标位置，对**可见的圆角矩形**做精确命中测试，
 *     据此翻转 `setIgnoreMouseEvents`。不用 `forward: true`：它在部分宿主上收不到
 *     指针回来的事件，策略就永远翻不回去。
 *   - **不会被任务栏压住**：窗口矩形永远夹在工作区（workArea）内，且用
 *     `screen-saver` 层级置顶；任务栏自动隐藏时（workArea == 全屏）额外留出底部余量。
 *     显示器工作区变化时会重新夹一次。
 *
 * 数据来自 bin/netspeed-sampler.exe（Electron/Node 没有网卡字节计数 API），
 * 主进程 spawn 它、逐行解析 JSON、再把样本推给渲染端。
 */

const { app, BrowserWindow, Menu, Tray, ipcMain, screen, nativeImage, shell, dialog, globalShortcut, nativeTheme } = require('electron');
const { spawn, execFile } = require('node:child_process');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ------------------------------------------------------------------ 启动留痕 */

/*
 * Electron 在 Chromium 沙箱起不来的宿主上会在任何 JS 执行之前直接死掉（无 stderr），
 * 所以“从没启动”和“建窗口时崩了”只能靠尽早写日志区分。
 */
const TRACE = process.env.DSH_NET_HUD_TRACE === '1';
function argValue(flagName) {
  const prefix = `--${flagName}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found === undefined ? undefined : found.slice(prefix.length);
}

/*
 * 打包（安装版）和源码运行两种形态的路径规则不一样：
 *  · 源码运行：一切都在仓库里，采样器在 hud-app/bin，状态在 hud-app/.state；
 *  · 安装版：代码被塞进 app.asar（只读），采样器/看门狗在 resources/bin，
 *    状态必须放到用户目录（%APPDATA%\Net HUD），不能往安装目录里写。
 * 三者都可以用命令行覆盖，看门狗就是这么把状态目录传进来的。
 */
const PACKAGED = app.isPackaged === true;
const RESOURCE_BIN = PACKAGED ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, 'bin');
const STATE_DIR = path.resolve(
  argValue('net-state-dir') ?? (PACKAGED ? app.getPath('userData') : path.join(__dirname, '.state')),
);
const PREFS_FILE = path.join(STATE_DIR, 'prefs.json');
const SAMPLER_PATH = path.resolve(argValue('net-sampler') ?? path.join(RESOURCE_BIN, 'netspeed-sampler.exe'));
const ASSETS = path.join(__dirname, 'assets');
const RENDERER = path.join(__dirname, 'renderer');

function trace(step) {
  if (!TRACE) return;
  const line = `${new Date().toISOString()} ${step}\n`;
  for (const file of [path.join(os.homedir(), '.dsh', 'net-hud', 'hud-boot.log'), path.join(__dirname, 'hud-boot.log')]) {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, line);
    } catch { /* 留痕绝不能成为启动失败的原因 */ }
  }
}
trace(`main.js reached: electron=${process.versions.electron ?? 'not-electron'} argv=${JSON.stringify(process.argv.slice(1))}`);

/*
 * 被 harness 启动的进程被限制在工作区内：写 %APPDATA% / %TEMP% / ~/.dsh 会 EPERM，
 * 而 Electron 启动时恰好要用它们（crashpad、HTTP 缓存、ProcessSingleton 锁），
 * 被拒之后不是降级而是直接死。所以每个 Chromium 自己的目录都重定向到状态目录里。
 */
for (const [key, folder] of [
  ['userData', 'chromium'],
  ['sessionData', 'session'],
  ['crashDumps', 'crash'],
  ['logs', 'logs'],
  ['temp', 'tmp'],
]) {
  try { app.setPath(key, path.join(STATE_DIR, folder)); } catch { /* 某些键在老版本上不存在，不能致命 */ }
}

/* -------------------------------------------------------------------- 日志 */

const APP_LOG = path.join(STATE_DIR, 'net-hud-app.log');
function logLine(message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  if (TRACE) process.stdout.write(`[net-hud] ${line}`);
  try {
    fs.mkdirSync(path.dirname(APP_LOG), { recursive: true });
    try { if (fs.statSync(APP_LOG).size > 96 * 1024) fs.renameSync(APP_LOG, `${APP_LOG}.1`); } catch { /* 还没有日志 */ }
    fs.appendFileSync(APP_LOG, line);
  } catch { /* 记日志绝不能成为失败原因 */ }
}

/*
 * 主进程里的任何未捕获异常，默认会让 Electron 弹一个**模态**错误框——组件卡在那里，
 * 而日志里一个字都没有。装个处理器：错误进日志，窗口继续跑（最坏是某个功能不工作，
 * 而不是一个必须人去点的对话框堵在桌面上）。
 */
process.on('uncaughtException', (error) => {
  logLine(`uncaught exception: ${error?.stack ?? error}`);
});
process.on('unhandledRejection', (reason) => {
  logLine(`unhandled rejection: ${reason?.stack ?? reason}`);
});

/* -------------------------------------------------------------------- 偏好 */

const DEFAULT_PREFS = {
  x: null,               // 窗口位置（DIP）；null = 用默认锚点
  y: null,
  scale: 1,              // 0.8 – 1.6
  unit: 'bytes',         // bytes = B/s（同任务管理器） | bits = bit/s（同宽带标称）
  intervalMs: 1000,      // 采样间隔
  nic: '',               // '' = 全部（已排除回环/隧道）
  theme: 'auto',         // auto | dark | light
  lang: 'auto',          // auto | zh | en（auto = 跟随系统）
  alwaysOnTop: true,
  locked: false,         // 锁定位置（拖动/贴边都停用）
  clickThrough: false,   // 全窗鼠标穿透（逃生口：托盘菜单 + 全局快捷键）
  visible: true,
  sparkline: true,       // 卡片背景的迷你走势
};

/* --------------------------------------------------------------- 界面语言 */

/*
 * 语言只影响界面文案，和采样、绘制都无关。
 * `auto` 用 app.getLocale()（Chromium 的系统语言），只有明确以 zh 开头才用中文，
 * 其余一律英文 —— 面向开源用户时这个默认方向更安全。
 */
const I18N = require('./i18n.js');
let LANG = 'zh';

function resolveLang() {
  const want = prefs.lang ?? DEFAULT_PREFS.lang;
  if (want === 'zh' || want === 'en') return want;
  const locale = String(app.getLocale() ?? '');
  return locale.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** t('menu.size', { scale: '1.20' }) —— 找不到就退回中文，再退回路径本身。 */
function t(path, vars) {
  const pick = (lang) => path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), I18N[lang]);
  const text = pick(LANG) ?? pick('zh');
  if (typeof text !== 'string') return path;
  if (vars === undefined) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) => (vars[name] === undefined ? match : String(vars[name])));
}

function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' ? value : fallback;
  } catch { return fallback; }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');   // 不写 BOM
  } catch (error) { logLine(`prefs write failed: ${error.message}`); }
}

const clampNumber = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

function normalizePrefs(stored) {
  const prefs = { ...DEFAULT_PREFS };
  if (stored === null || typeof stored !== 'object') return prefs;
  for (const key of Object.keys(DEFAULT_PREFS)) {
    if (!(key in stored)) continue;
    const value = stored[key];
    switch (key) {
      case 'x':
      case 'y':
        prefs[key] = Number.isFinite(Number(value)) ? Math.round(Number(value)) : null;
        break;
      case 'scale': prefs.scale = clampNumber(value, 0.8, 1.6, 1); break;
      case 'intervalMs': prefs.intervalMs = clampNumber(value, 500, 5000, 1000); break;
      case 'unit': prefs.unit = value === 'bits' ? 'bits' : 'bytes'; break;
      case 'theme': prefs.theme = ['auto', 'dark', 'light'].includes(value) ? value : 'auto'; break;
      case 'lang': prefs.lang = ['auto', 'zh', 'en'].includes(value) ? value : 'auto'; break;
      case 'nic': prefs.nic = typeof value === 'string' ? value : ''; break;
      default: prefs[key] = value === true;
    }
  }
  return prefs;
}

let prefs = normalizePrefs(readJson(PREFS_FILE, null));
if (prefs.x !== null && prefs.y !== null) { /* 位置由 clampToWorkArea 兜底 */ }
LANG = resolveLang();

/* ------------------------------------------------------------------ 尺寸 */

/*
 * 所有尺寸都以 scale=1 的“基础像素”书写，渲染端按同一乘数套 CSS `zoom`，
 * 主进程按同一乘数设窗口尺寸——一个乘数同时移动画面、文字和窗口。
 */
const BASE_W = 100;
const BASE_H = 68;
const BASE_RADIUS = 15;
const TASKBAR_RESERVE = 48;   // 任务栏自动隐藏时，底部留出的余量（DIP）

const scaled = (base) => Math.round(base * prefs.scale);
const windowSize = () => ({ width: scaled(BASE_W), height: scaled(BASE_H) });

/*
 * 可用区域：正常取 workArea（它已经排除了任务栏）；任务栏自动隐藏时
 * workArea 等于整个屏幕，这时手动留出底部余量，免得被弹出的任务栏压住。
 */
function usableArea() {
  const display = screen.getPrimaryDisplay();
  const area = display.workArea;
  const bounds = display.bounds;
  const bottomIsScreenEdge = area.y + area.height >= bounds.y + bounds.height - 1;
  if (!bottomIsScreenEdge) return area;
  return { x: area.x, y: area.y, width: area.width, height: Math.max(120, area.height - TASKBAR_RESERVE) };
}

/** 贴边判定与吸附：到左右边 ≤ 阈值就吸上去。 */
const SNAP_THRESHOLD = 72;

function clampToArea(x, y, width, height) {
  const area = usableArea();
  const displays = screen.getAllDisplays();
  const anyVisible = displays.some((display) => {
    const a = display.workArea;
    return x + width > a.x + 8 && x < a.x + a.width - 8 && y + height > a.y + 8 && y < a.y + a.height - 8;
  });
  if (!anyVisible) return defaultAnchor(width, height);
  const maxX = area.x + area.width - width;
  const maxY = area.y + area.height - height;
  return {
    x: Math.round(Math.min(Math.max(x, area.x), maxX)),
    y: Math.round(Math.min(Math.max(y, area.y), maxY)),
  };
}

/**
 * 默认锚点：贴右边缘、竖直居中。
 *
 * 刻意不放在右下角：状态组件就住在那里（它是可拖动的，但默认在右下），
 * 两个挂件叠在一起比放中间难看得多。竖直居中既贴边又和它错开。
 */
function defaultAnchor(width, height) {
  const area = usableArea();
  return {
    x: Math.round(area.x + area.width - width),
    y: Math.round(area.y + (area.height - height) / 2),
  };
}

/** 可见卡片矩形（窗口本地坐标）。窗口就是卡片，所以这里没有留白。 */
function cardRect() {
  return { x: 0, y: 0, width: windowSize().width, height: windowSize().height, radius: Math.round(BASE_RADIUS * prefs.scale) };
}

/** 圆角矩形的精确命中测试：卡片的四个圆角是最容易吃掉桌面点击的地方。 */
function roundedRectHit(x, y, width, height, radius) {
  if (x < 0 || y < 0 || x > width || y > height) return false;
  const r = Math.min(radius, width / 2, height / 2);
  if (r <= 0) return true;
  const cx = x < r ? r : (x > width - r ? width - r : x);
  const cy = y < r ? r : (y > height - r ? height - r : y);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 贴边后的目标位置：吸到最近的一条侧边，纵坐标不变。 */
function snappedBounds(side, width, height, y) {
  const area = usableArea();
  const x = side === 'left' ? area.x : area.x + area.width - width;
  const maxY = area.y + area.height - height;
  return { x: Math.round(x), y: Math.round(Math.min(Math.max(y, area.y), maxY)), width, height };
}

function nearestSide(x, width) {
  const area = usableArea();
  const left = x - area.x;
  const right = area.x + area.width - (x + width);
  const side = left <= right ? 'left' : 'right';
  return Math.min(left, right) <= SNAP_THRESHOLD ? side : null;
}

/* ------------------------------------------------------------------ 采样器 */

let sampler = null;
let samplerRetry = 0;
let samplerTimer = null;
let samplerBuffer = '';
let samplerOk = false;
let latest = null;
let peak = { rx: 0, tx: 0 };
let total = { rx: 0, tx: 0 };
let lastSampleAt = 0;

function resetAggregates() {
  peak = { rx: 0, tx: 0 };
  total = { rx: 0, tx: 0 };
  latest = null;
  lastSampleAt = 0;
  sendSample();
}

function pickInterface(sample) {
  const list = Array.isArray(sample.ifaces) ? sample.ifaces : [];
  if (prefs.nic === '') {
    return { rx: sample.rx, tx: sample.tx, rxTotal: sample.rxTotal, txTotal: sample.txTotal };
  }
  const hit = list.find((item) => item.name === prefs.nic);
  if (hit === undefined) return { rx: 0, tx: 0, rxTotal: 0, txTotal: 0 };
  return { rx: hit.rx, tx: hit.tx, rxTotal: hit.rxTotal, txTotal: hit.txTotal };
}

function onSamplerLine(line) {
  const text = line.trim();
  if (text === '' || text[0] !== '{') return;
  let sample;
  try { sample = JSON.parse(text); } catch { return; }

  const now = Number(sample.rx);
  if (!Number.isFinite(now)) return;

  const picked = pickInterface(sample);
  const rx = Number.isFinite(Number(picked.rx)) ? Number(picked.rx) : 0;
  const tx = Number.isFinite(Number(picked.tx)) ? Number(picked.tx) : 0;
  if (rx > peak.rx) peak.rx = rx;
  if (tx > peak.tx) peak.tx = tx;

  // 网卡重新选择后累计值会跳变，所以累计只在“单调增”的时候累加
  const rxTotal = Number(picked.rxTotal);
  const txTotal = Number(picked.txTotal);
  if (Number.isFinite(rxTotal) && rxTotal >= (latest?.rxTotal ?? 0)) total.rx += Math.max(0, rxTotal - (latest?.rxTotal ?? rxTotal));
  if (Number.isFinite(txTotal) && txTotal >= (latest?.txTotal ?? 0)) total.tx += Math.max(0, txTotal - (latest?.txTotal ?? txTotal));

  latest = {
    rx,
    tx,
    rxTotal: Number.isFinite(rxTotal) ? rxTotal : 0,
    txTotal: Number.isFinite(txTotal) ? txTotal : 0,
    sessionRx: total.rx,
    sessionTx: total.tx,
    peakRx: peak.rx,
    peakTx: peak.tx,
    at: Date.now(),
    ifaces: Array.isArray(sample.ifaces) ? sample.ifaces : [],
  };
  lastSampleAt = latest.at;
  samplerOk = true;
  sendSample();
  refreshTraySoon();
}

function sendSample() {
  if (win === null || win.isDestroyed()) return;
  win.webContents.send('net:command', {
    type: 'sample',
    sample: latest,
    peak,
    session: total,
    samplerOk,
    intervalMs: prefs.intervalMs,
  });
}

/** 用户显式退出：留一个标记，宿主看到就不再拉起（否则“退出”约等于“重启”）。 */
function markQuit() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.writeFileSync(path.join(STATE_DIR, 'quit'), `${new Date().toISOString()}\n`, 'utf8');
  } catch (error) {
    logLine(`quit marker failed: ${error.message}`);
  }
}

function samplerArgs() {
  const args = [`--interval=${Math.round(prefs.intervalMs)}`];
  return args;
}

function stopSampler() {
  if (samplerTimer !== null) { clearTimeout(samplerTimer); samplerTimer = null; }
  if (sampler === null) return;
  const child = sampler;
  sampler = null;
  try { child.stdout?.removeAllListeners(); } catch { /* 已经没了 */ }
  try { child.kill(); } catch { /* 已经退出 */ }
}

function startSampler() {
  stopSampler();
  if (!fs.existsSync(SAMPLER_PATH)) {
    logLine(`sampler missing: ${SAMPLER_PATH}`);
    samplerOk = false;
    if (win !== null && !win.isDestroyed()) win.webContents.send('net:command', { type: 'error', message: t('samplerMissing') });
    return;
  }
  let child;
  try {
    child = spawn(SAMPLER_PATH, samplerArgs(), { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  } catch (error) {
    logLine(`sampler spawn failed: ${error.message}`);
    scheduleSamplerRetry();
    return;
  }
  sampler = child;
  samplerBuffer = '';
  logLine(`sampler started pid=${child.pid} interval=${prefs.intervalMs}ms`);

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    samplerBuffer += chunk;
    let index = samplerBuffer.indexOf('\n');
    while (index >= 0) {
      const line = samplerBuffer.slice(0, index);
      samplerBuffer = samplerBuffer.slice(index + 1);
      onSamplerLine(line);
      index = samplerBuffer.indexOf('\n');
    }
    if (samplerBuffer.length > 64 * 1024) samplerBuffer = '';
  });
  child.on('error', (error) => logLine(`sampler error: ${error.message}`));
  child.on('exit', (code, signal) => {
    if (sampler !== child) return;
    sampler = null;
    samplerOk = false;
    logLine(`sampler exited code=${code} signal=${signal}`);
    scheduleSamplerRetry();
  });
}

function scheduleSamplerRetry() {
  if (samplerTimer !== null) return;
  const delay = Math.min(10000, 500 * 2 ** samplerRetry);
  samplerRetry += 1;
  samplerTimer = setTimeout(() => {
    samplerTimer = null;
    startSampler();
  }, delay);
  samplerTimer.unref?.();
}

/* -------------------------------------------------------------------- 主题 */

function resolvedTheme() {
  if (prefs.theme === 'dark') return 'dark';
  if (prefs.theme === 'light') return 'light';
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
}

function sendShell() {
  if (win === null || win.isDestroyed()) return;
  win.webContents.send('net:command', {
    type: 'shell',
    shell: {
      theme: resolvedTheme(),
      unit: prefs.unit,
      lang: LANG,
      scale: prefs.scale,
      sparkline: prefs.sparkline,
      locked: prefs.locked,
      clickThrough: prefs.clickThrough,
      baseW: BASE_W,
      baseH: BASE_H,
      radius: BASE_RADIUS,
      intervalMs: prefs.intervalMs,
      version: app.getVersion(),
    },
  });
}

/* ------------------------------------------------------------------ 窗口 */

let win = null;
let tray = null;
let trayRefreshTimer = null;
let dragging = false;
let dragOffset = null;
let dragTimer = null;
let dragWatchdog = null;
let mousePolicyApplied = null;
let snapSide = null;
let snapshotMode = false;

const DRAG_WATCHDOG_MS = 12000;
/*
 * 光标轮询的两档频率（DIP 半径 POLL_NEAR_PAD 之内算“贴近”）：
 *  · 指针贴近卡片时 24ms ≈ 40Hz：悬停高亮和“点得中”都要跟手；
 *  · 指针在屏幕别处时 150ms：只是等它回来，没必要高频。
 * 原来是一律 80ms，而且**每一跳都往渲染进程发一条 IPC**（12.5 次/秒，内容没变也发），
 * 既费主进程也持续把渲染进程从空闲里叫醒。现在只在 over 状态真的翻转时才发。
 * 指针穿透打开或窗口隐藏时干脆停表：那时没有任何命中测试要做。
 */
const POLL_NEAR_MS = 24;
const POLL_FAR_MS = 150;
const POLL_NEAR_PAD = 64;

let cursorTimer = null;
let pointerOver = null;

function frameIntervalMs() {
  let hz = 0;
  try { hz = screen.getPrimaryDisplay()?.displayFrequency ?? 0; } catch { /* 还没有 display 对象 */ }
  if (!Number.isFinite(hz) || hz < 30 || hz > 360) hz = 60;
  return Math.max(4, Math.round((1000 / hz) * 0.7));
}

function createWindow() {
  const size = windowSize();
  let anchor = prefs.x !== null && prefs.y !== null
    ? clampToArea(prefs.x, prefs.y, size.width, size.height)
    : defaultAnchor(size.width, size.height);

  /*
   * 记住的位置也要重新贴一次边：窗口宽度会随缩放/卡片尺寸变化，
   * 直接沿用旧的 x 会在屏幕边上留出一条缝（看起来就是"没贴住"）。
   */
  snapSide = nearestSide(anchor.x, size.width);
  if (snapSide !== null) {
    const snapped = snappedBounds(snapSide, size.width, size.height, anchor.y);
    anchor = { x: snapped.x, y: snapped.y };
  }
  prefs.x = anchor.x;
  prefs.y = anchor.y;

  win = new BrowserWindow({
    width: size.width,
    height: size.height,
    x: anchor.x,
    y: anchor.y,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#00000000',
    focusable: false,                       // 永不抢焦点
    icon: path.join(ASSETS, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  win.setAlwaysOnTop(prefs.alwaysOnTop, 'screen-saver');
  if (typeof win.setVisibleOnAllWorkspaces === 'function') {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  mousePolicyApplied = null;
  applyMousePolicy(false);

  /*
   * 渲染端诊断：生产环境没有 devtools，插件又是 stdio: 'ignore' 起的进程，
   * 渲染端的异常、CSP 拒绝、preload 失败否则完全不可见——组件只会一直停在旧帧。
   */
  const contents = win.webContents;
  contents.on('console-message', (_event, level, message, line, source) => {
    const severity = typeof level === 'number' ? level : 0;
    if (severity >= 2 || TRACE) logLine(`renderer[${severity}] ${message} (${String(source).split('/').pop()}:${line})`);
  });
  contents.on('did-fail-load', (_e, code, description, url) => logLine(`renderer load FAILED ${code} ${description} ${url}`));
  contents.on('preload-error', (_e, preloadPath, error) => logLine(`preload FAILED ${preloadPath}: ${error.message}`));
  contents.on('render-process-gone', (_e, details) => logLine(`renderer GONE ${details.reason} exit=${details.exitCode}`));

  win.loadFile(path.join(RENDERER, 'index.html'));

  win.once('ready-to-show', () => {
    if (prefs.visible) win.showInactive();
    sendShell();
    sendSample();
    startCursorWatch();
    if (snapshotMode) scheduleSnapshot();
    scheduleEval();
  });

  // 'move' 在拖动时连续触发，所以写文件做防抖；拖拽结束时另有一次立即写入。
  let positionTimer = null;
  win.on('move', () => {
    if (positionTimer !== null) clearTimeout(positionTimer);
    positionTimer = setTimeout(() => {
      positionTimer = null;
      if (win === null || win.isDestroyed() || dragging) return;
      const [x, y] = win.getPosition();
      prefs.x = x; prefs.y = y;
      writeJson(PREFS_FILE, prefs);
    }, 400);
  });
  win.on('closed', () => {
    if (positionTimer !== null) clearTimeout(positionTimer);
    win = null;
  });
  return win;
}

/* --------------------------------------------------- 鼠标策略与光标轮询 */

function applyMousePolicy(ignore) {
  if (win === null || win.isDestroyed()) return;
  if (mousePolicyApplied === ignore) return;
  mousePolicyApplied = ignore;
  try { win.setIgnoreMouseEvents(ignore); } catch (error) { logLine(`setIgnoreMouseEvents failed: ${error.message}`); }
}

function scheduleCursor(delay) {
  if (cursorTimer !== null) clearTimeout(cursorTimer);
  cursorTimer = setTimeout(cursorTick, delay);
  cursorTimer.unref?.();
}

function cursorTick() {
  cursorTimer = null;
  if (win === null || win.isDestroyed()) return;
  // 穿透 / 隐藏时没有任何命中测试要做，直接停表（改回来时会重新启动）
  if (prefs.clickThrough || !win.isVisible()) { applyMousePolicy(true); return; }
  if (dragging) { applyMousePolicy(false); scheduleCursor(POLL_NEAR_MS); return; }

  const point = screen.getCursorScreenPoint();
  const bounds = win.getBounds();
  const rect = cardRect();
  const localX = point.x - bounds.x;
  const localY = point.y - bounds.y;
  const over = roundedRectHit(localX, localY, rect.width, rect.height, rect.radius);
  applyMousePolicy(!over);
  if (over !== pointerOver) {
    pointerOver = over;
    if (!win.isDestroyed()) win.webContents.send('net:command', { type: 'pointer', over });
  }

  const near = localX >= -POLL_NEAR_PAD && localY >= -POLL_NEAR_PAD
    && localX <= bounds.width + POLL_NEAR_PAD && localY <= bounds.height + POLL_NEAR_PAD;
  scheduleCursor(near ? POLL_NEAR_MS : POLL_FAR_MS);
}

function startCursorWatch() {
  if (cursorTimer !== null) return;
  if (prefs.clickThrough) return;
  if (win === null || win.isDestroyed() || !win.isVisible()) return;
  cursorTick();
}

function stopCursorWatch() {
  if (cursorTimer !== null) { clearTimeout(cursorTimer); cursorTimer = null; }
  pointerOver = null;          // 下次显示时重新播报一次悬停状态
}

/* ------------------------------------------------------------ 拖动与贴边 */

function startDrag() {
  if (win === null || win.isDestroyed() || prefs.locked) return;
  const point = screen.getCursorScreenPoint();
  const [x, y] = win.getPosition();
  dragOffset = { dx: point.x - x, dy: point.y - y };
  dragging = true;
  snapSide = null;
  applyMousePolicy(false);
  if (dragTimer !== null) clearInterval(dragTimer);
  dragTimer = setInterval(() => {
    if (!dragging || win === null || win.isDestroyed() || dragOffset === null) return;
    const cursor = screen.getCursorScreenPoint();
    win.setPosition(cursor.x - dragOffset.dx, cursor.y - dragOffset.dy);
  }, frameIntervalMs());
  dragTimer.unref?.();
  armDragWatchdog();
  if (win !== null && !win.isDestroyed()) win.webContents.send('net:command', { type: 'dragging', on: true });
}

function armDragWatchdog() {
  if (dragWatchdog !== null) clearTimeout(dragWatchdog);
  dragWatchdog = setTimeout(() => {
    dragWatchdog = null;
    if (!dragging) return;
    logLine('drag watchdog fired; releasing a drag the renderer never ended');
    endDragInternal(true);
  }, DRAG_WATCHDOG_MS);
  dragWatchdog.unref?.();
}

function stopDragLoop() {
  if (dragTimer !== null) { clearInterval(dragTimer); dragTimer = null; }
  dragOffset = null;
}

function endDragInternal(moved) {
  if (dragWatchdog !== null) { clearTimeout(dragWatchdog); dragWatchdog = null; }
  stopDragLoop();
  const wasDragging = dragging;
  dragging = false;
  if (win === null || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  if (wasDragging && moved) settleAfterDrop(x, y);
  else {
    prefs.x = x; prefs.y = y;
    writeJson(PREFS_FILE, prefs);
  }
  cursorTick();
  if (win !== null && !win.isDestroyed()) win.webContents.send('net:command', { type: 'dragging', on: false });
}

/** 松手：离左右边够近就吸附贴边，否则留在原地。 */
function settleAfterDrop(x, y) {
  const size = windowSize();
  const side = nearestSide(x, size.width);
  if (side !== null) {
    snapSide = side;
    const target = snappedBounds(side, size.width, size.height, y);
    win.setBounds(target);
    prefs.x = target.x; prefs.y = target.y;
  } else {
    const clamped = clampToArea(x, y, size.width, size.height);
    win.setBounds({ ...clamped, width: size.width, height: size.height });
    prefs.x = clamped.x; prefs.y = clamped.y;
  }
  writeJson(PREFS_FILE, prefs);
  sendShell();
}

/** 显示器工作区/分辨率变化后重新夹一次，绝不留在任务栏底下或屏幕外。 */
function reclamp() {
  if (win === null || win.isDestroyed()) return;
  const size = windowSize();
  const [x, y] = win.getPosition();
  const next = snapSide !== null ? snappedBounds(snapSide, size.width, size.height, y) : clampToArea(x, y, size.width, size.height);
  win.setBounds({ ...next, width: size.width, height: size.height });
  prefs.x = next.x; prefs.y = next.y;
  writeJson(PREFS_FILE, prefs);
  sendShell();
}

/* ------------------------------------------------------------------ 托盘 */

function formatSpeed(bytesPerSecond, unit) {
  let value = unit === 'bits' ? bytesPerSecond * 8 : bytesPerSecond;
  const units = unit === 'bits' ? ['b/s', 'Kb/s', 'Mb/s', 'Gb/s'] : ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  const text = index === 0 ? String(Math.round(value))
    : value < 10 ? value.toFixed(2)
      : value < 100 ? value.toFixed(1)
        : String(Math.round(value));
  return `${text} ${units[index]}`;
}

function trayTooltip() {
  if (latest === null) return t('tray.idle');
  const unit = prefs.unit;
  return [
    `${t('tray.title')}  ${prefs.nic === '' ? t('tray.allNics') : prefs.nic}`,
    `↓ ${formatSpeed(latest.rx, unit)}   ↑ ${formatSpeed(latest.tx, unit)}`,
    `${t('tray.peak')} ↓ ${formatSpeed(peak.rx, unit)}   ↑ ${formatSpeed(peak.tx, unit)}`,
  ].join('\n');
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = Number(bytes) || 0;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

function refreshTraySoon() {
  if (tray === null || trayRefreshTimer !== null) return;
  trayRefreshTimer = setTimeout(() => {
    trayRefreshTimer = null;
    if (tray === null || tray.isDestroyed()) return;
    try { tray.setToolTip(trayTooltip()); } catch { /* 托盘可能正在重建 */ }
  }, 900);
  trayRefreshTimer.unref?.();
}

function nicSubmenu() {
  const list = Array.isArray(latest?.ifaces) ? latest.ifaces : [];
  const items = [{ label: t('menu.nicAll'), type: 'radio', checked: prefs.nic === '', click: () => setPrefs({ nic: '' }) }];
  const seen = new Set();
  for (const nic of list) {
    if (seen.has(nic.name)) continue;
    seen.add(nic.name);
    items.push({
      label: `${nic.up ? '' : t('menu.nicDown')}${nic.name}`,
      type: 'radio',
      checked: prefs.nic === nic.name,
      click: () => setPrefs({ nic: nic.name }),
    });
  }
  if (items.length === 1) items.push({ label: t('menu.nicEmpty'), enabled: false });
  return items;
}

function scaleSubmenu() {
  const presets = [0.8, 0.9, 1, 1.15, 1.3, 1.6];
  return presets.map((value) => ({
    label: `${value.toFixed(2)}×`,
    type: 'radio',
    checked: Math.abs(prefs.scale - value) < 0.001,
    click: () => setPrefs({ scale: value }),
  }));
}

/*
 * 开机自启有**两条**路径，因为一条不够：
 *
 *  1. 计划任务 NetSpeedHud（登录触发器）—— 首选，能在「任务计划程序」里看到、能禁用。
 *  2. 注册表 Run 键 HKCU\...\Run —— 兜底。
 *
 * 为什么要兜底：实测在一台受限令牌的机器上，`schtasks /Create` 和 PowerShell 的
 * `Register-ScheduledTask` **都**返回 Access is denied（同一个用户、同一个任务名，
 * 早先还建成功过），而 Run 键一次就写进去了。普通用户（非管理员）装这个组件时
 * 不该因为建不了计划任务就没有开机自启。
 *
 * 开关的状态 = 「任务启用」或「Run 键存在」；打开时两条都写，关掉时两条都清。
 */
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_VALUE = 'NetHUD';
const TASK_NAME = 'NetSpeedHud';       // 与 tools/install.ps1 和看门狗里的常量一致
let autoStartState = 'unknown';        // on | off | unknown

/** Run 键里那条命令行：打包版让看门狗自己推导路径，源码版把路径写全。 */
function runKeyCommand() {
  const watchdog = path.join(RESOURCE_BIN, 'net-hud-watchdog.exe');
  const args = PACKAGED
    ? ['--packaged=1']
    : [
      `--electron=${process.execPath}`,
      `--app=${__dirname}`,
      `--state=${STATE_DIR}`,
      `--sampler=${SAMPLER_PATH}`,
    ];
  return `"${watchdog}" ${args.join(' ')}`;
}

function queryRunKey() {
  return new Promise((resolve) => {
    execFile('reg', ['query', RUN_KEY, '/v', RUN_VALUE], { windowsHide: true }, (error) => resolve(error === null));
  });
}

function writeRunKey(on) {
  return new Promise((resolve) => {
    const args = on
      ? ['add', RUN_KEY, '/v', RUN_VALUE, '/t', 'REG_SZ', '/d', runKeyCommand(), '/f']
      : ['delete', RUN_KEY, '/v', RUN_VALUE, '/f'];
    execFile('reg', args, { windowsHide: true }, (error) => resolve(error === null));
  });
}

/** 查计划任务：不存在返回 'missing'，被禁用返回 'off'，启用返回 'on'。 */
function queryTask() {
  return new Promise((resolve) => {
    execFile('schtasks', ['/Query', '/TN', TASK_NAME, '/XML'], { windowsHide: true }, (error, stdout) => {
      if (error) { resolve('missing'); return; }
      const text = String(stdout).replace(/\0/g, '');
      resolve(/<Enabled>\s*false\s*<\/Enabled>/i.test(text) ? 'off' : 'on');
    });
  });
}

function changeTask(enable) {
  return new Promise((resolve) => {
    execFile('schtasks', ['/Change', '/TN', TASK_NAME, enable ? '/ENABLE' : '/DISABLE'],
      { windowsHide: true }, (error) => resolve(error === null));
  });
}

async function refreshAutoStart() {
  const task = await queryTask();
  const run = await queryRunKey();
  autoStartState = (task === 'on' || run) ? 'on' : 'off';
  return autoStartState;
}

function autoStartMenuItem() {
  return {
    label: t('menu.autostart'),
    type: 'checkbox',
    checked: autoStartState === 'on',
    click: (item) => { void toggleAutoStart(item.checked); },
  };
}

async function toggleAutoStart(on) {
  const task = await queryTask();
  const taskOk = task === 'missing' ? true : await changeTask(on);
  const runOk = await writeRunKey(on);
  if (on && !taskOk && !runOk) {
    logLine('autostart enable failed: both scheduled task and Run key were rejected');
    dialog.showErrorBox(t('dialog.autostartTitle'), t('dialog.autostartFailed', { detail: 'Access denied' }));
    return;
  }
  autoStartState = on ? 'on' : 'off';
  logLine(`autostart ${on ? 'enabled' : 'disabled'} (task=${task}/${taskOk} runKey=${runOk})`);
  if (tray !== null && !tray.isDestroyed()) {
    try {
      tray.displayBalloon({
        title: t('appName'),
        content: on ? t('balloon.autostartOn') : t('balloon.autostartOff'),
      });
    } catch { /* 气泡提示失败无所谓，菜单里的勾已经变了 */ }
  }
}

/*
 * 安装程序用的两条一次性命令：注册/注销开机自启。
 * 保留给"源码安装版"（tools/install.ps1 的替代品）和手动使用。
 */
function registerAutostartTask() {
  return new Promise((resolve) => {
    const watchdog = path.join(RESOURCE_BIN, 'net-hud-watchdog.exe');
    const tr = `"${watchdog}" --packaged=1`;
    execFile('schtasks', ['/Create', '/TN', TASK_NAME, '/TR', tr, '/SC', 'ONLOGON', '/RL', 'LIMITED', '/F'],
      { windowsHide: true }, async (error, stdout, stderr) => {
        const detail = String(stderr || stdout || error?.message || '').trim();
        logLine(`register autostart: ${error === null ? 'ok' : 'FAILED'} (${tr}) ${detail}`);
        if (error === null) { resolve(true); return; }
        resolve(await writeRunKey(true));      // 建不了任务就退回 Run 键
      });
  });
}

function unregisterAutostartTask() {
  return new Promise((resolve) => {
    execFile('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], { windowsHide: true }, async (error, stdout) => {
      logLine(`unregister autostart: ${error === null ? 'ok' : 'skip'} ${String(stdout).trim()}`);
      await writeRunKey(false);
      resolve(true);
    });
  });
}

/** 菜单弹出前先刷一次自启状态：勾必须反映真实状态，而不是启动时的缓存。 */
async function showMenu(options) {
  await refreshAutoStart();
  const menu = windowMenu();
  if (menu === null) return;
  menu.popup(options ?? {});
}

function windowMenu() {
  if (win === null || win.isDestroyed()) return null;
  return Menu.buildFromTemplate([
    { label: latest === null ? t('connecting') : `↓ ${formatSpeed(latest.rx, prefs.unit)}   ↑ ${formatSpeed(latest.tx, prefs.unit)}`, enabled: false },
    { label: latest === null ? '' : `${t('tray.peak')} ↓ ${formatSpeed(peak.rx, prefs.unit)}   ↑ ${formatSpeed(peak.tx, prefs.unit)}`, enabled: false },
    { type: 'separator' },
    {
      label: t('menu.unit'),
      submenu: [
        { label: t('menu.unitBytes'), type: 'radio', checked: prefs.unit === 'bytes', click: () => setPrefs({ unit: 'bytes' }) },
        { label: t('menu.unitBits'), type: 'radio', checked: prefs.unit === 'bits', click: () => setPrefs({ unit: 'bits' }) },
      ],
    },
    {
      label: t('menu.interval'),
      submenu: [500, 1000, 2000, 5000].map((ms) => ({
        label: t('menu.seconds', { n: ms / 1000 }),
        type: 'radio',
        checked: prefs.intervalMs === ms,
        click: () => setPrefs({ intervalMs: ms }),
      })),
    },
    { label: t('menu.nic'), submenu: nicSubmenu() },
    { label: t('menu.size', { scale: prefs.scale.toFixed(2) }), submenu: scaleSubmenu() },
    {
      label: t('menu.theme'),
      submenu: [
        { label: t('menu.themeAuto'), type: 'radio', checked: prefs.theme === 'auto', click: () => setPrefs({ theme: 'auto' }) },
        { label: t('menu.themeDark'), type: 'radio', checked: prefs.theme === 'dark', click: () => setPrefs({ theme: 'dark' }) },
        { label: t('menu.themeLight'), type: 'radio', checked: prefs.theme === 'light', click: () => setPrefs({ theme: 'light' }) },
      ],
    },
    {
      label: t('menu.language'),
      submenu: [
        { label: t('menu.langAuto'), type: 'radio', checked: prefs.lang === 'auto', click: () => setPrefs({ lang: 'auto' }) },
        { label: t('menu.langZh'), type: 'radio', checked: prefs.lang === 'zh', click: () => setPrefs({ lang: 'zh' }) },
        { label: t('menu.langEn'), type: 'radio', checked: prefs.lang === 'en', click: () => setPrefs({ lang: 'en' }) },
      ],
    },
    { type: 'separator' },
    { label: t('menu.sparkline'), type: 'checkbox', checked: prefs.sparkline, click: (item) => setPrefs({ sparkline: item.checked }) },
    { label: t('menu.alwaysOnTop'), type: 'checkbox', checked: prefs.alwaysOnTop, click: (item) => setPrefs({ alwaysOnTop: item.checked }) },
    { label: t('menu.locked'), type: 'checkbox', checked: prefs.locked, click: (item) => setPrefs({ locked: item.checked }) },
    autoStartMenuItem(),
    {
      label: prefs.clickThrough ? t('menu.clickThroughHint') : t('menu.clickThrough'),
      type: 'checkbox',
      checked: prefs.clickThrough,
      click: (item) => setPrefs({ clickThrough: item.checked }),
    },
    { type: 'separator' },
    { label: t('menu.snapRight'), enabled: !prefs.locked, click: () => { snapSide = 'right'; reclamp(); } },
    { label: t('menu.snapLeft'), enabled: !prefs.locked, click: () => { snapSide = 'left'; reclamp(); } },
    { label: t('menu.resetPosition'), click: () => resetPosition() },
    { label: t('menu.openStateDir'), click: () => { void shell.openPath(STATE_DIR); } },
    { type: 'separator' },
    { label: t('menu.restartSampler'), click: () => { samplerRetry = 0; stopSampler(); resetAggregates(); startSampler(); } },
    { label: t('menu.about'), click: () => { void showAbout(); } },
    { type: 'separator' },
    { label: prefs.visible ? t('menu.hide') : t('menu.show'), click: () => setVisible(!prefs.visible) },
    { label: t('menu.quit'), click: () => { markQuit(); app.quit(); } },
  ]);
}

function createTray() {
  let image = nativeImage.createFromPath(path.join(ASSETS, 'tray.png'));
  const isEmpty = image.isEmpty();
  if (isEmpty) {
    logLine(`tray icon failed to load: ${path.join(ASSETS, 'tray.png')}`);
    image = nativeImage.createEmpty();
  }
  try {
    tray = new Tray(image);
  } catch (error) {
    logLine(`tray creation failed: ${error.message}`);
    tray = null;
    return null;
  }
  tray.setToolTip(trayTooltip());
  tray.on('click', () => setVisible(!prefs.visible));
  tray.on('right-click', () => { void showMenu({ window: win ?? undefined }); });
  logLine(`tray created (icon empty=${isEmpty}, size=${JSON.stringify(image.getSize())})`);
  return tray;
}

function setVisible(next) {
  prefs.visible = next === true;
  writeJson(PREFS_FILE, prefs);
  if (win === null || win.isDestroyed()) return;
  if (prefs.visible) win.showInactive(); else win.hide();
  // 隐藏时没必要做命中测试，显示回来再重新开始
  if (prefs.visible) startCursorWatch(); else stopCursorWatch();
}

function resetPosition() {
  if (win === null || win.isDestroyed()) return;
  const size = windowSize();
  const anchor = defaultAnchor(size.width, size.height);
  snapSide = 'right';
  win.setBounds({ ...anchor, width: size.width, height: size.height });
  prefs.x = anchor.x; prefs.y = anchor.y;
  writeJson(PREFS_FILE, prefs);
}

async function showAbout() {
  await dialog.showMessageBox({
    type: 'info',
    title: t('appName'),
    message: `${t('appName')} v${app.getVersion()}`,
    detail: t('about.body', {
      sampler: SAMPLER_PATH,
      missing: fs.existsSync(SAMPLER_PATH) ? '' : t('about.missing'),
      interval: prefs.intervalMs,
      nic: prefs.nic === '' ? t('about.nicAll') : prefs.nic,
      prefs: PREFS_FILE,
      log: APP_LOG,
    }),
    buttons: [t('about.ok')],
  });
}

/* ------------------------------------------------------------ 偏好写入口 */

function setPrefs(patch) {
  const before = { ...prefs };
  prefs = normalizePrefs({ ...prefs, ...patch });
  writeJson(PREFS_FILE, prefs);

  if (before.lang !== prefs.lang) {
    LANG = resolveLang();
    refreshTraySoon();          // 托盘提示里也有文案
    logLine(`language -> ${LANG}`);
  }

  if (win !== null && !win.isDestroyed()) {
    win.setAlwaysOnTop(prefs.alwaysOnTop, 'screen-saver');
    if (before.scale !== prefs.scale || before.locked !== prefs.locked) {
      const size = windowSize();
      const [x, y] = win.getPosition();
      const next = snapSide !== null ? snappedBounds(snapSide, size.width, size.height, y) : clampToArea(x, y, size.width, size.height);
      win.setBounds({ ...next, width: size.width, height: size.height });
      prefs.x = next.x; prefs.y = next.y;
    }
    if (before.clickThrough !== prefs.clickThrough) {
      mousePolicyApplied = null;
      if (prefs.clickThrough) stopCursorWatch(); else startCursorWatch();
    }
    sendShell();
  }
  if (before.intervalMs !== prefs.intervalMs || before.nic !== prefs.nic) {
    resetAggregates();
    if (before.intervalMs !== prefs.intervalMs) { samplerRetry = 0; startSampler(); }
  }
  logLine(`prefs updated: ${JSON.stringify(patch)}`);
}

/* -------------------------------------------------------------- 快捷键 */

const SHORTCUTS = [
  ['CommandOrControl+Alt+N', 'toggleVisible'],
  ['CommandOrControl+Alt+C', 'toggleClickThrough'],
  ['CommandOrControl+Alt+S', 'snapRight'],
];

function registerShortcuts() {
  const handlers = {
    toggleVisible: () => setVisible(!prefs.visible),
    toggleClickThrough: () => setPrefs({ clickThrough: !prefs.clickThrough }),
    snapRight: () => { snapSide = snapSide === 'right' ? null : 'right'; reclamp(); },
  };
  let ok = 0;
  for (const [accelerator, name] of SHORTCUTS) {
    try {
      if (globalShortcut.register(accelerator, handlers[name])) ok += 1;
      else logLine(`shortcut taken: ${accelerator}`);
    } catch (error) { logLine(`shortcut failed ${accelerator}: ${error.message}`); }
  }
  return ok;
}

/* --------------------------------------------- 截图与表达式求值（验证用） */

/*
 * 组件是逐像素透明的分层窗口，GDI 的 BitBlt（CopyFromScreen）**不会**合成它，
 * 抓屏只能拍到它背后的东西。所以让窗口自己拍。
 */
function scheduleSnapshot() {
  const target = argValue('net-snapshot');
  if (target === undefined) return;
  const delay = clampNumber(argValue('net-snapshot-delay') ?? 1200, 0, 60000, 1200);
  setTimeout(async () => {
    try {
      const image = await win.webContents.capturePage();
      fs.mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
      fs.writeFileSync(path.resolve(target), image.toPNG());
      logLine(`snapshot written ${target}`);
    } catch (error) {
      logLine(`snapshot failed: ${error.message}`);
    }
    app.quit();
  }, delay);
}

/*
 * 在渲染端跑一段表达式并把结果写进日志：这是把"只有眼睛能看见的事"变成可断言数据的入口
 * （例如连采两次 __netStats() 比较 frames 与 writes，验证"收帧"和"重画"是分开的）。
 */
function scheduleEval() {
  let code = argValue('net-eval');
  const file = argValue('net-eval-file');
  if ((code === undefined || code === '') && file !== undefined) {
    try { code = fs.readFileSync(path.resolve(file), 'utf8'); } catch (error) { logLine(`eval file unreadable: ${error.message}`); return; }
  }
  if (code === undefined || code === '') return;
  const delay = clampNumber(argValue('net-eval-delay') ?? 3000, 0, 120000, 3000);
  setTimeout(async () => {
    try {
      const result = await win.webContents.executeJavaScript(code, true);
      logLine(`eval result: ${JSON.stringify(result)}`);
    } catch (error) {
      logLine(`eval failed: ${error.message}`);
    }
    if (argValue('net-eval-keep') === undefined) app.quit();
  }, delay);
}

/* ---------------------------------------------------------------- IPC */

ipcMain.on('net:ready', () => { sendShell(); sendSample(); });
ipcMain.on('net:drag-start', () => startDrag());
ipcMain.on('net:drag-end', (_event, moved) => endDragInternal(moved === true));
ipcMain.on('net:menu', () => {
  if (win === null || win.isDestroyed()) return;
  void showMenu({ window: win });
});
ipcMain.handle('net:load-prefs', () => prefs);
ipcMain.on('net:save-prefs', (_event, patch) => {
  if (patch === null || typeof patch !== 'object') return;
  setPrefs(patch);
});
ipcMain.handle('net:diagnostics', () => ({
  sampler: { path: SAMPLER_PATH, exists: fs.existsSync(SAMPLER_PATH), pid: sampler?.pid ?? null, retries: samplerRetry },
  lastSampleAt,
  prefs,
  stateDir: STATE_DIR,
}));

/* --------------------------------------------------------------- 生命周期 */

/*
 * 单实例：不用 requestSingleInstanceLock()（它要在 userData 下建锁，目录不可写时会
 * 把进程直接干掉而不是返回 false），改用 PID 文件 + 存活探测。第二份直接安静退出——
 * 计划任务、开始菜单快捷方式、DSH 插件都可能同时想拉起它，重叠启动是常态而不是异常。
 *
 * 判断用**回环端口**，不用 PID 文件。PID 文件会撒谎：进程退出后 Windows 会把 PID
 * 复用给别的进程，于是“这个 PID 还活着”会误判——实测真的踩到了，pid 文件里的 20188
 * 后来变成了 LockApp.exe，结果每次启动都以为自己已经跑着、安静退出。
 * 端口的归属由内核维护：进程一死立刻释放，不存在过期状态；而且要回一句 net-hud 才算数，
 * 别的程序碰巧占了同一个端口也不会被误判。
 */
const LOCK_PORT = 48711;
let lockServer = null;

function probeRunningInstance() {
  return new Promise((resolve) => {
    let answered = false;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* 已经关了 */ }
      resolve(value);
    };
    const socket = net.connect({ port: LOCK_PORT, host: '127.0.0.1' });
    socket.setTimeout(600, () => finish(false));
    socket.on('connect', () => { try { socket.write('net-hud?\n'); } catch { /* 对方已关 */ } });
    socket.on('data', (chunk) => { if (String(chunk).includes('net-hud')) answered = true; });
    socket.on('close', () => finish(answered));
    socket.on('error', () => finish(false));
  });
}

function startLockServer() {
  lockServer = net.createServer((socket) => {
    socket.on('error', () => { /* 对方提前断开 */ });
    socket.end('net-hud\n');
  });
  lockServer.on('error', (error) => {
    logLine(`lock server 起不来（${error.code}）：单实例判断退化为不做，组件照常运行`);
    lockServer = null;  });
  try { lockServer.listen(LOCK_PORT, '127.0.0.1'); } catch (error) { logLine(`lock listen failed: ${error.message}`); }
}

try {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(PID_FILE, `${process.pid}\n`, 'utf8');   // 只作排查用的便利文件
} catch { /* 失败不致命 */ }

/*
 * 默认**关**硬件加速（保留原来 disableHardwareAcceleration 的行为），实测过：
 * 这台机器的“GPU”是软件模拟（虚拟机里没有真实显卡直通），打开后 Chromium 会走
 * SwiftShader，CPU 从 单核 30% 涨到 47%、私有内存从 199MB 涨到 259MB —— 更糟。
 * 有真实显卡的机器可以用 `--net-gpu` 打开，那时 GPU 合成本该几乎免费。
 */
if (argValue('net-gpu') === undefined) app.disableHardwareAcceleration?.();

app.whenReady().then(async () => {
  trace('app ready');

  /*
   * 语言要在 ready 之后再定一次。
   * `app.getLocale()` 在 ready 之前返回空串（文档也要求 ready 之后调用），于是
   * "跟随系统"会静默退化成英文 —— 中文系统上界面全变英文，而且没有任何报错。
   * 实测踩到：安装版窗口标题一直是 "Net HUD"。
   */
  LANG = resolveLang();
  logLine(`ui language=${LANG} locale=${app.getLocale()} preferred=${JSON.stringify(app.getPreferredSystemLanguages?.() ?? [])}`);

  /*
   * 安装程序用的两条一次性命令：注册/注销开机自启的计划任务。
   * 放在最前面 —— 它不该受单实例锁影响，也不该开窗口，做完就退出。
   */
  if (argValue('register-autostart') !== undefined) {
    app.exit(await registerAutostartTask() ? 0 : 1);
    return;
  }
  if (argValue('unregister-autostart') !== undefined) {
    // 注销不是失败：本来就没有这个任务，也算成功
    await unregisterAutostartTask();
    app.exit(0);
    return;
  }

  snapshotMode = argValue('net-snapshot') !== undefined;
  /*
   * 单实例保护对两种启动方式让路：
   *  · --net-snapshot：自拍实例永远要能起来（它拍完就退）
   *  · --net-allow-multi=1：开发实例（换一个 state 目录起第二份调试），只有 tools 里的脚本会传
   */
  const singleInstance = !snapshotMode && argValue('net-allow-multi') !== '1';
  if (singleInstance) {
    if (await probeRunningInstance()) {
      logLine('another instance is already running; exiting');
      app.exit(0);
      return;
    }
    startLockServer();
  }
  createWindow();
  if (!snapshotMode) {
    createTray();
    registerShortcuts();
  }
  nativeTheme.on('updated', () => sendShell());
  screen.on('display-metrics-changed', () => reclamp());
  screen.on('display-added', () => reclamp());
  screen.on('display-removed', () => reclamp());
  startSampler();
  logLine(`ready: state=${STATE_DIR} sampler=${SAMPLER_PATH}`);
}).catch((error) => {
  logLine(`whenReady failed: ${error.stack ?? error.message}`);
});

app.on('window-all-closed', () => { app.quit(); });
app.on('before-quit', () => {
  stopSampler();
  stopCursorWatch();
  try { globalShortcut.unregisterAll(); } catch { /* 无所谓 */ }
  try { fs.unlinkSync(PID_FILE); } catch { /* 已经没了 */ }
});
