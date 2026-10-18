# MXH Route 1.14.2-mxh.15

减少配置处理后和后台空闲时的内存占用，并保留代理运行和日常操作所需的功能。

- 及时释放配置处理后的临时堆、离开连接页后的旧表、恢复日志后的暂停副本，以及切换字体产生的旧对象。
- 隐藏界面暂停可恢复的数据展示和轮询；已停止代理且没有活动工作时，后台按需释放通信辅助进程。
- 打开的连接页继续接收后台历史；切回窗口保留健康连接流、编辑草稿和终端会话。
- 终端和版本说明按需加载，功能文件仍完整内置，可离线使用。字体、上游图标、托盘、更新代理与取消、故障切换及系统代理/TUN 功能保留。

本地通过 233 项桌面/界面测试、4 项核心内存生命周期测试，以及四种运行状态的隔离验收。测试中的后台停用状态首次唤醒辅助进程约需 0.6 秒。

内存和 CPU 的测试条件、结果及边界见 [性能验收记录](https://github.com/mxh110708/mxh-route-desktop/blob/v1.14.2-mxh.15/docs/MEMORY-PERFORMANCE-2026-10-18.zh-CN.md)。安装包沿用现有签名身份，附 SHA-256 校验文件。

源码：[核心](https://github.com/mxh110708/mxh-route-core/commit/4bdadb511d31fff678f264d3d8bea28a17b07048)、[界面](https://github.com/mxh110708/mxh-route-dashboard/commit/79ece355daae4c11730aec130e5d4189ab2f8d0f)、[桌面](https://github.com/mxh110708/mxh-route-desktop/tree/v1.14.2-mxh.15)。
