; ============================================================================
;  NSIS 定制片段（electron-builder 的 include）
;
;  这里只做两件事：安装后注册开机自启、卸载前注销。
;
;  注册/注销交给**看门狗**（原生程序）自己做，不让安装程序去跑
;  `Net HUD.exe --register-autostart`：实测踩到过 —— 如果进程环境里有
;  ELECTRON_RUN_AS_NODE（Electron 的 Node 模式开关），那个 exe 会以纯 Node 启动、
;  参数一律报 bad option，任务根本没注册上。原生程序不受环境变量影响。
;
;  顺便：任务的动作只是"看门狗 --packaged=1"，40 来个字符，离 schtasks /TR 的
;  261 字符上限很远（路径全部由看门狗从自己的位置推导）。
;
;  安装/卸载前先杀看门狗和采样器：看门狗会把窗口重新拉起来，文件就被占住了。
; ============================================================================

!macro customInit
  nsExec::ExecToLog 'taskkill /IM net-hud-watchdog.exe /F'
  nsExec::ExecToLog 'taskkill /IM netspeed-sampler.exe /F'
!macroend

!macro customInstall
  ; 注册开机自启（计划任务，失败自动退回 Run 键）
  nsExec::ExecToLog '"$INSTDIR\resources\bin\net-hud-watchdog.exe" --register-task'
  ; 然后立刻把它跑起来。
  ; 注意这里用 NSIS 的 Exec（不等待）而不是 nsExec：看门狗是常驻进程，永远不会退出，
  ; 等它就把安装程序卡死了。也不能用 `schtasks /Run`：在某些受限环境里任务根本建不出来，
  ; 那条路一失败，装完就什么都不启动。
  Exec '"$INSTDIR\resources\bin\net-hud-watchdog.exe" --packaged=1'
!macroend

!macro customUnInit
  nsExec::ExecToLog 'taskkill /IM net-hud-watchdog.exe /F'
  nsExec::ExecToLog 'taskkill /IM netspeed-sampler.exe /F'
  nsExec::ExecToLog '"$INSTDIR\resources\bin\net-hud-watchdog.exe" --unregister-task'
!macroend
