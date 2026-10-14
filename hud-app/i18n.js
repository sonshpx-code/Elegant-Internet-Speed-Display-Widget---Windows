/* ============================================================================
 *  i18n.js —— 界面文案（中 / 英），主进程与渲染层共用这一份。
 *
 *  写成 UMD 形状是刻意的：
 *   · 主进程用 require('./i18n.js') 拿到对象；
 *   · 渲染层用 <script src="i18n.js"> 拿到 window.NET_HUD_I18N
 *     （CSP 是 script-src 'self' 且没有 connect-src，所以只能 script 引入，
 *       fetch 一个 JSON 会被 CSP 挡掉）。
 *
 *  取值走路径：t('menu.size', { scale: '1.00' })，{name} 是占位符。
 *  语言只影响**界面文案**；单位符号（B/s、KB/s）与日志是语言无关的。
 * ========================================================================== */
(function (root, factory) {
  const dict = factory();
  if (typeof module === 'object' && module.exports) module.exports = dict;
  else root.NET_HUD_I18N = dict;
})(typeof self !== 'undefined' ? self : this, function () {
  return {
    zh: {
      appName: '网速悬浮组件',
      tagline: '贴着屏幕边缘悬浮的实时网速组件',
      aria: '实时网速',
      connecting: '连接采样器…',
      samplerMissing: '找不到网速采样器',
      samplerStopped: '采样已停止',
      samplerNotRunning: '采样器未运行',

      tray: {
        idle: '网速 · 正在连接采样器…',
        title: '网速',
        allNics: '全部网卡',
        peak: '峰值',
      },

      menu: {
        unit: '单位',
        unitBytes: '字节 B/s（同任务管理器）',
        unitBits: '比特 bit/s（同宽带标称）',
        interval: '刷新间隔',
        seconds: '{n} 秒',
        nic: '统计网卡',
        nicAll: '全部（不含回环/隧道）',
        nicDown: '（未连接）',
        nicEmpty: '（还没有采样数据）',
        size: '大小（当前 {scale}×）',
        theme: '主题',
        themeAuto: '跟随系统',
        themeDark: '深色',
        themeLight: '浅色',
        language: '语言 / Language',
        langAuto: '跟随系统 / Auto',
        langZh: '中文',
        langEn: 'English',
        sparkline: '卡片背景走势',
        alwaysOnTop: '始终置顶',
        locked: '锁定位置',
        autostart: '开机自动启动',
        autostartNoTask: '开机自动启动（未安装计划任务）',
        clickThrough: '鼠标穿透',
        clickThroughHint: '鼠标穿透（用快捷键或此菜单解除）',
        snapRight: '贴到屏幕右边缘',
        snapLeft: '贴到屏幕左边缘',
        resetPosition: '回到默认位置',
        openStateDir: '打开状态目录',
        restartSampler: '刷新采样器',
        about: '关于…',
        hide: '隐藏组件（可从这里恢复）',
        show: '显示组件',
        quit: '退出',
      },

      dialog: {
        autostartTitle: '开机自动启动',
        autostartFailed: '设置失败：{detail}\n\n可以重新运行安装程序，或手动注册计划任务。',
      },
      balloon: {
        autostartOn: '已开启开机自动启动',
        autostartOff: '已关闭开机自动启动',
      },

      about: {
        body: [
          '贴着屏幕边缘悬浮的实时网速组件（↓ 下载 / ↑ 上传）。',
          '常驻运行：登录自启、异常退出自动重启，不依赖任何其它程序。',
          '',
          '采样器：{sampler}{missing}',
          '采样间隔：{interval} ms    统计网卡：{nic}',
          '偏好文件：{prefs}',
          '日志：{log}',
          '',
          '左键拖动移动位置（松手自动贴边）；右键打开此菜单；双击托盘图标显示/隐藏。',
          '这里点「退出」只会把它停到下次登录；彻底卸载请用安装目录里的卸载程序。',
        ].join('\n'),
        missing: '（缺失！）',
        nicAll: '全部',
        ok: '好',
      },
    },

    en: {
      appName: 'Net HUD',
      tagline: 'A live network speed widget that floats at the edge of your screen',
      aria: 'Live network speed',
      // 提示条只有 78px 可用（卡片 100px 减左右内边距），英文必须短：
      // 实测 “Sampler is not running” 会被卡片边缘截掉。
      connecting: 'Connecting…',
      samplerMissing: 'Sampler missing',
      samplerStopped: 'Sampler paused',
      samplerNotRunning: 'Sampler offline',

      tray: {
        idle: 'Net speed · connecting…',
        title: 'Net speed',
        allNics: 'All interfaces',
        peak: 'Peak',
      },

      menu: {
        unit: 'Unit',
        unitBytes: 'Bytes B/s (like Task Manager)',
        unitBits: 'Bits bit/s (like ISP ratings)',
        interval: 'Refresh interval',
        seconds: '{n} s',
        nic: 'Interface',
        nicAll: 'All (excluding loopback/tunnel)',
        nicDown: ' (down)',
        nicEmpty: '(no samples yet)',
        size: 'Size (now {scale}×)',
        theme: 'Theme',
        themeAuto: 'Follow system',
        themeDark: 'Dark',
        themeLight: 'Light',
        language: 'Language / 语言',
        langAuto: 'Auto / 跟随系统',
        langZh: '中文',
        langEn: 'English',
        sparkline: 'Trend sparkline',
        alwaysOnTop: 'Always on top',
        locked: 'Lock position',
        autostart: 'Start at login',
        autostartNoTask: 'Start at login (scheduled task not installed)',
        clickThrough: 'Click-through',
        clickThroughHint: 'Click-through (release with the shortcut or this menu)',
        snapRight: 'Dock to right edge',
        snapLeft: 'Dock to left edge',
        resetPosition: 'Reset position',
        openStateDir: 'Open state folder',
        restartSampler: 'Restart sampler',
        about: 'About…',
        hide: 'Hide widget (restore from here)',
        show: 'Show widget',
        quit: 'Quit',
      },

      dialog: {
        autostartTitle: 'Start at login',
        autostartFailed: 'Failed: {detail}\n\nRe-run the installer, or register the scheduled task manually.',
      },
      balloon: {
        autostartOn: 'Start at login enabled',
        autostartOff: 'Start at login disabled',
      },

      about: {
        body: [
          'A live network speed widget floating at the edge of your screen (↓ download / ↑ upload).',
          'Resident: starts at login, auto-restarts after a crash, depends on nothing else.',
          '',
          'Sampler: {sampler}{missing}',
          'Interval: {interval} ms    Interface: {nic}',
          'Preferences: {prefs}',
          'Log: {log}',
          '',
          'Drag with the left button to move it (snaps to the edge); right-click for this menu; double-click the tray icon to show/hide.',
          '"Quit" here only stops it until the next login. To remove it completely, use the uninstaller in the install folder.',
        ].join('\n'),
        missing: ' (MISSING!)',
        nicAll: 'All',
        ok: 'OK',
      },
    },
  };
});
