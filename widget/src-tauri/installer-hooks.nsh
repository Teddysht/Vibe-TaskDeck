; Vibe-TaskDeck NSIS 安装钩子：
; 强制创建桌面快捷方式。Tauri 模板把桌面图标放在完成页勾选框（默认不勾），
; 一路「下一步」的静默习惯会漏掉——本钩子在安装段直接创建，完成页勾选仍保留（幂等）。
!macro NSIS_HOOK_POSTINSTALL
  Call CreateOrUpdateDesktopShortcut
!macroend
