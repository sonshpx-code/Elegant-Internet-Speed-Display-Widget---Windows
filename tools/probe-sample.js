/*
 * 数值来源探针：把“卡片上看到的”和“渲染端收到的原始字节/秒”一起报出来，
 * 再和同期的系统计数器对拍。数值对不上时，这一条能直接指出是采样器、
 * IPC 还是格式化的哪一段出了问题。
 */
new Promise((resolve) => {
  const a = window.__netStats();
  setTimeout(() => {
    const b = window.__netStats();
    resolve({
      link: b.link,
      frames: `${a.frames} -> ${b.frames}`,
      rawRx_bps: b.lastRaw ? Math.round(b.lastRaw.rx) : null,
      rawTx_bps: b.lastRaw ? Math.round(b.lastRaw.tx) : null,
      rawIfaces: b.lastRaw ? b.lastRaw.ifaces : null,
      shownDown: `${b.shownDown} ${document.getElementById('rx-unit').textContent}`,
      shownUp: `${b.shownUp} ${document.getElementById('tx-unit').textContent}`,
      history: b.history,
      sampleAgeMs: b.lastRaw ? Date.now() - b.lastRaw.at : null,
    });
  }, 4000);
});
