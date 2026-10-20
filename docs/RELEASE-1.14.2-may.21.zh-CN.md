# May Route 1.14.2-may.21

修复安装器在最后整理快捷方式时误报 `Could not reconcile the application shortcuts` 的问题。

NSIS 安装器为 32 位进程。此前启动的 32 位 PowerShell 会将现有快捷方式中的 Program Files 目标重定向为 Program Files (x86)，导致正确的 May Route 入口被误判为其他应用。现在安装和卸载统一通过原生 PowerShell 解析、维护快捷方式，继续保留对其他应用入口的保护。

增加真正的 32 位 NSIS 宿主回归：复现原故障，验证修复后的合并行为和外部同名入口保护。此版本保留已有配置和安装身份，没有加入失败状态识别或旧版本兼容分支。
