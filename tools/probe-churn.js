/*
 * 闪烁回归探针（配合 tools/fake-sampler.cs 的恒定值样本使用）。
 *
 * 断言：样本帧一直在到（frames 涨），但 DOM 写入一动不动（writes 不涨）。
 * 这正是当年状态组件“每秒闪一次”的那条回归——把只有眼睛能发现的事变成一行可断言的数据。
 */
new Promise((resolve) => {
  const a = window.__netStats();
  setTimeout(() => {
    const b = window.__netStats();
    const framesGained = b.frames - a.frames;
    const writesGained = b.writes - a.writes;
    resolve({
      frames: `${a.frames} -> ${b.frames}`,
      writes: `${a.writes} -> ${b.writes}`,
      framesGained,
      writesGained,
      link: b.link,
      unit: b.unit,
      verdict: framesGained > 0 && writesGained === 0 ? 'PASS' : 'FAIL',
    });
  }, 5000);
});
