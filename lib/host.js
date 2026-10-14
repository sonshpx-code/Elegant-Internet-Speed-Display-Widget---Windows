/**
 * dsh-net-hud —— DSH 宿主半边。
 *
 * 它只做三件事：读配置、把 Electron 窗口进程拉起来、在它意外退出时按退避重启。
 * 网速数据完全在窗口进程内部产生（它自己 spawn bin/netspeed-sampler.exe），
 * 所以这里**没有回环桥、没有 SSE、没有 token**——半边越薄，能坏的地方越少。
 *
 * 与 dsh-status-hud 的差异（都是有意为之）：
 *   · 稳定运行 60 秒后重启计数归零：参考实现里计数器永不重置，跑了一整天之后
 *     一次偶发退出就可能直接耗尽配额、从此不再自愈。
 *   · 真正的"用户退出"通道：窗口在退出前写 <stateDir>/quit 标记，宿主看到标记就
 *     不再拉起。参考实现的 quit-requested 事件从来没有人 emit 过，
 *     于是"退出组件"实际等于"最多被自动拉起 5 次"。
 *   · dispose 时先 kill，1.5 秒后还在就 taskkill /T /F 清掉整棵进程树
 *     （Electron 会派生 renderer/gpu/utility 子进程）。
 *
 * 只 import node: 内置模块，不声明任何 peerDependencies：安装时没有任何依赖要解析。
 */

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'net-hud';

const CONFIG_DIR = join(homedir(), '.dsh', 'net-hud');
const CONFIG_FILE = join(CONFIG_DIR, 'plugin.json');
const LOG_FILE = join(CONFIG_DIR, 'hud.log');

const DEFAULTS = {
  autoLaunch: true,          // 插件挂载时启动窗口
  hudAppDir: null,           // 默认由本包位置推导
  electronPath: null,        // 默认由 hud-app 推导（可指向别处已有的 electron）
  stateDir: null,            // 默认 <hudAppDir>/.state
  relaunchLimit: 5,          // 重启次数上限
  noSandbox: process.platform === 'win32',
  stableResetMs: 60000,      // 稳定运行超过这个时长就把重启计数清零
  debug: false,
};

/* ------------------------------------------------------------------ 基础设施 */

function appendLog(line) {
  const text = `${new Date().toISOString()} ${line}\n`;
  if (DEFAULTS.debug) process.stdout.write(`[net-hud] ${text}`);
  try {
    mkdirSync(dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, text);
  } catch {
    /* 记日志绝不能成为插件挂载失败的原因 */
  }
}

/** 读 JSON 必须容忍 UTF-8 BOM：plugin.json 是给人手改的，记事本会写 BOM，而 JSON.parse 拒绝它。 */
function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

function packageDir() {
  try {
    return resolve(dirname(fileURLToPath(import.meta.url)), '..');
  } catch {
    return process.cwd();
  }
}

/**
 * 每次都重新解析：运行中改了配置或补装了 Electron，下一轮重启就能生效。
 * 命中判据是「目录里有 main.js」/「可执行文件存在」，不做版本校验。
 */
function resolveLaunchPaths(settings) {
  const base = packageDir();
  const candidates = [
    settings.hudAppDir,
    join(base, 'hud-app'),
    join(base, '..', 'hud-app'),
    join(homedir(), '.dsh', 'net-hud', 'hud-app'),
  ].filter((value) => typeof value === 'string' && value !== '');

  const hudAppDir = candidates.find((dir) => existsSync(join(dir, 'main.js'))) ?? null;
  if (hudAppDir === null) return { hudAppDir: null, electronPath: null, candidates };

  const electronCandidates = [
    settings.electronPath,
    join(hudAppDir, 'node_modules', 'electron', 'dist', 'electron.exe'),
    join(hudAppDir, 'node_modules', 'electron', 'dist', 'electron'),
    join(hudAppDir, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron'),
    // 复用兄弟项目已经装好的 Electron：一个窗口不需要第二份 190MB 运行时
    join(base, '..', 'dsh-status-hud', 'hud-app', 'node_modules', 'electron', 'dist', 'electron.exe'),
    join(homedir(), '.dsh', 'status-hud', 'hud-app', 'node_modules', 'electron', 'dist', 'electron.exe'),
  ].filter((value) => typeof value === 'string' && value !== '');

  return {
    hudAppDir,
    electronPath: electronCandidates.find((file) => existsSync(file)) ?? null,
    candidates,
  };
}

function writePidFile(stateDir, pid) {
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, 'supervisor.json'), `${JSON.stringify({ pid, at: Date.now() }, null, 2)}\n`, 'utf8');
  } catch {
    /* 只是给排查用的便利文件 */
  }
}

/* ------------------------------------------------------------------ 插件 */

export function apply(ctx, config) {
  const settings = { ...DEFAULTS, ...(readJson(CONFIG_FILE, {}) ?? {}), ...(config ?? {}) };
  const relaunchLimit = Number.isFinite(Number(settings.relaunchLimit)) ? Number(settings.relaunchLimit) : DEFAULTS.relaunchLimit;
  const stableResetMs = Number.isFinite(Number(settings.stableResetMs)) ? Number(settings.stableResetMs) : DEFAULTS.stableResetMs;

  ctx.effect(() => {
    let child = null;
    let relaunches = 0;
    let stopping = false;
    let retryTimer = null;

    const resolvedNow = resolveLaunchPaths(settings);
    const stateDir = typeof settings.stateDir === 'string' && settings.stateDir !== ''
      ? settings.stateDir
      : join(resolvedNow.hudAppDir ?? packageDir(), '.state');
    const quitMarker = join(stateDir, 'quit');

    appendLog(`mount: config=${CONFIG_FILE} stateDir=${stateDir}`);

    /** 用户显式退出会留下这个标记；消费掉它并返回 true。 */
    function consumeQuitMarker() {
      try {
        if (!existsSync(quitMarker)) return false;
        rmSync(quitMarker, { force: true });
        return true;
      } catch {
        return false;
      }
    }

    function launch() {
      const { hudAppDir, electronPath, candidates } = resolveLaunchPaths(settings);
      if (hudAppDir === null) {
        appendLog(`hud-app not found; looked at: ${candidates.join(' | ')}`);
        return;
      }
      if (electronPath === null) {
        appendLog(`electron not found for ${hudAppDir}; 在该目录执行 pnpm install（或配置 electronPath）`);
        return;
      }

      const args = [
        // Chromium 开关必须排在 app 路径之前：Electron 把第一个非开关参数当 app 目录
        ...(settings.noSandbox ? ['--no-sandbox'] : []),
        `--user-data-dir=${join(stateDir, 'chromium')}`,
        `--disk-cache-dir=${join(stateDir, 'cache')}`,
        `--crash-dumps-dir=${join(stateDir, 'crash')}`,
        `--net-state-dir=${stateDir}`,
        `--net-sampler=${join(hudAppDir, 'bin', 'netspeed-sampler.exe')}`,
        ...(typeof settings.snapshotPath === 'string' && settings.snapshotPath !== ''
          ? [`--net-snapshot=${settings.snapshotPath}`]
          : []),
        hudAppDir,
      ];

      // 桌面宿主自己就是 Electron 的 Node 模式，环境里带着 ELECTRON_RUN_AS_NODE；
      // 继承下去窗口会以纯 Node 启动，require('electron') 立刻失败。
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.NODE_OPTIONS;

      let next;
      try {
        next = spawn(electronPath, args, {
          cwd: hudAppDir,
          detached: false,
          stdio: 'ignore',
          windowsHide: false,
          env,
        });
      } catch (error) {
        appendLog(`spawn threw: ${error.message}`);
        return;
      }

      child = next;
      const startedAt = Date.now();
      writePidFile(stateDir, next.pid);
      appendLog(`launch pid=${next.pid} app=${hudAppDir} electron=${electronPath}`);

      next.on('error', (error) => {
        appendLog(`spawn failed: ${error.message}`);
        if (child === next) child = null;
      });

      next.on('exit', (code, signal) => {
        const uptime = Date.now() - startedAt;
        appendLog(`exit code=${code} signal=${signal} after ${uptime}ms`);
        if (child === next) child = null;
        if (stopping) return;

        if (consumeQuitMarker()) {
          appendLog('用户显式退出，不再拉起');
          return;
        }
        // 秒退且退出码为 0：多半是"已经有一份在跑了"，不该当成崩溃来重启
        if (code === 0 && uptime < 5000) {
          appendLog('窗口秒退（可能已有一份在运行），不接管');
          return;
        }
        // 稳定跑过一段时间的偶发退出，不该消耗重启配额
        if (uptime >= stableResetMs && relaunches > 0) {
          appendLog(`稳定运行 ${Math.round(uptime / 1000)}s，重启计数归零`);
          relaunches = 0;
        }
        if (relaunches >= relaunchLimit) {
          appendLog(`窗口已重启 ${relaunches} 次，放弃（详见 ${LOG_FILE}）`);
          return;
        }
        relaunches += 1;
        const delay = Math.min(1000 * 2 ** relaunches, 30000);
        appendLog(`${delay}ms 后第 ${relaunches} 次拉起`);
        retryTimer = setTimeout(() => {
          retryTimer = null;
          if (!stopping) launch();
        }, delay);
        retryTimer.unref?.();
      });
    }

    if (settings.autoLaunch) launch();
    else appendLog('autoLaunch 为 false：请自行启动窗口（hud-app 目录下 npm start 或直接跑 electron）');

    return () => {
      stopping = true;
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
      const doomed = child;
      child = null;
      if (doomed === null || doomed.pid === undefined) return;

      try { doomed.kill(); } catch { /* 已经没了 */ }

      // Electron 会派生 renderer/gpu/utility 子进程；主进程被干掉后它们通常自行收尸，
      // 但没有保证。1.5 秒后还在就整棵树清掉。
      const pid = doomed.pid;
      const killer = setTimeout(() => {
        try {
          process.kill(pid, 0);          // 还活着才会走到下面
          const taskkill = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
          taskkill.on('error', () => { /* 没有 taskkill 就算了 */ });
        } catch {
          /* 进程已经退出 */
        }
      }, 1500);
      killer.unref?.();
      appendLog(`dispose: killed pid=${pid}`);
    };
  }, 'net-hud: HUD process supervision');
}
