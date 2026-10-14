# Net HUD 1.0.0

**An elegant, low-resource real-time network speed widget for Windows.**

A 100×68 translucent card that floats at the edge of your screen and shows live
download/upload speed — always on top, never in the way, never stealing focus.

![Net HUD on the desktop](https://raw.githubusercontent.com/sonshpx-code/Elegant-Internet-Speed-Display-Widget---Windows/main/docs/preview.png)

## Download

`NetHUD-Setup-1.0.0.exe` — per-user install, **no administrator rights needed**.
It installs to `%LOCALAPPDATA%\Programs\Net HUD`, registers start-at-login, and launches
the widget. Uninstall from *Apps & features*.

## Highlights

- **Upload on top, download below.** Arrow markers sit at a fixed position near the left
  edge, so a changing digit count never shifts the layout.
- **Speed-tier units.** `B/s` → `KB/s` → `MB/s` → `GB/s` get progressively brighter and
  bolder — one glance tells you the magnitude.
- **Resident.** Starts at login and a 14 KB native watchdog brings it back in **~2 seconds**
  if it ever dies. It depends on nothing else — no companion app, no runtime to install.
- **Quiet.** Measured idle cost on a 20-thread machine: **0.65% of the whole CPU**,
  ~190 MB private memory in total.
- **Honest numbers.** The sampler reads the same interface counters Task Manager uses and
  was cross-checked against `Get-NetAdapterStatistics()`.
- **Bilingual UI** (English / 中文), following the system language, switchable at runtime.
- **Edge snapping, click-through mode, tray icon, hotkeys, dark/light theme, bytes or bits,
  per-interface selection, trend sparkline.**

## Under the hood

```
Scheduled task / Run key (at logon)
  └─ net-hud-watchdog.exe      14 KB native, no runtime: spawns, waits, decides whether to restart
       └─ Net HUD.exe          Electron, transparent + always-on-top + never focused
            └─ netspeed-sampler.exe   8 KB native, one JSON line per interval
```

Both native helpers are compiled with the `csc.exe` that ships with Windows — the
repository has no build toolchain requirement and the app has no runtime dependency.

## What measuring (not guessing) changed

The first version cost **~30% of one CPU core** for a card that updates twice a second.
Two measured findings fixed that:

1. An infinite CSS animation on a machine without GPU compositing means 60 fps of
   *software* repaints (renderer + GPU process ≈ 18% of a core). The arrow "breathing" is
   now driven by JavaScript at 4 Hz — ~1/15 the repaints, same look.
2. Cursor polling sent an IPC message on every tick (12.5/s, changed or not). It now
   messages only on change, polls at 40 Hz near the card and 6.7 Hz when the pointer is
   elsewhere, and stops entirely in click-through mode or while hidden.

Enabling hardware acceleration made it *worse* on the development machine (software
"GPU" → SwiftShader fallback: 47% of a core, +60 MB), so it stays off by default with a
`--net-gpu` opt-in.

## Notes

- Windows 10 / 11, x64.
- Start-at-login uses a scheduled task when possible and falls back to a per-user
  `Run` key — on managed/sandboxed sessions task creation can be denied outright, and a
  non-admin user should not lose autostart because of that.
- The installer is not code-signed, so SmartScreen may show a warning: *More info →
  Run anyway*. Building from source is fully supported.
- MIT licensed. Source, architecture notes and the full verification log:
  [README](https://github.com/sonshpx-code/Elegant-Internet-Speed-Display-Widget---Windows#readme)
