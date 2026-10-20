# May Route 1.14.2-mxh.16

减少后台连接页的内存和 CPU 开销，保留连接历史、编辑草稿和活动终端。

- 打开的连接页在后台继续保存历史，暂停隐藏列表的重绘；返回界面时显示最新记录。
- Windows 启动不再加载 Linux 托盘专用的 D-Bus 库。
- 设置、网络工具、端点和报告页面按需从本地安装包加载，保持离线可用。
- 退出工具页面后释放可重建缓存；配置模式生成完成后释放原始响应缓存。

两轮后台连接页隔离压力测试中，保留 1000 条历史时，私有工作集样本中位数约从 535 MiB 降至 193 MiB，CPU 明显下降；恢复后历史和列表完整。普通概述页的稳定内存基本持平，不能把压力测试降幅推广到日常全部场景。

236 项桌面/界面测试通过；草稿、字体、终端会话及真实回环代理的历史、长连接、日志、停止/启动和节点选择回归通过。测量条件及边界见 [第三轮性能验收记录](https://github.com/mxh110708/may-route-desktop/blob/v1.14.2-mxh.16/docs/THIRD-PERFORMANCE-2026-10-18.zh-CN.md)。安装包沿用现有签名身份，附 SHA-256 校验文件。

源码：[核心](https://github.com/mxh110708/may-route-core/commit/09fb6465a7ce13e9a39335d3893b4152cbaac458)、[界面](https://github.com/mxh110708/may-route-dashboard/commit/ba9cc1649e02f068009f3423894a99027983a44c)、[桌面](https://github.com/mxh110708/may-route-desktop/tree/v1.14.2-mxh.16)。
