# May Route 文档

基线：Windows x64，1.14.2-may.26。[English overview](../README.en.md) · [English guide](USER-GUIDE.en.md)。

## 使用顺序

1. [首页](../README.md)：职责、平台、模式和配套项目。
2. [使用手册](USER-GUIDE.zh-CN.md)：安装、配置、流量接管、故障切换、托盘和更新。
3. [排错](TROUBLESHOOTING.zh-CN.md)：规则／校园授权、监测、代理保持、更新和资源。

| 专项 | 文档 |
| --- | --- |
| 入口顺序、按实际使用检测、分区延迟、确认与恢复 | [故障切换](PRIORITY-FAILOVER.zh-CN.md) |
| 独立更新代理、下载与取消 | [更新连接](UPDATE-CONNECTION.zh-CN.md) |
| 监听与保存／加载 | [代理端口](PROXY-PORTS.zh-CN.md) |
| 手动测速的测量阶段 | [延迟测量](LATENCY-MEASUREMENT.zh-CN.md) |
| 构建、子模块、核心与验证 | [开发与配套](DEVELOPMENT.zh-CN.md)、[实现说明](../CUSTOM.md) |

## 实现和历史

[历史索引](HISTORY.md)按原文件保留发行、实验、性能保留／撤回和真实验收记录。旧版本名称、测量值与候选状态是当时证据，不是当前资源保证或逐项操作教程。

上游核心协议文档、Dashboard 与桌面支持范围分开。用户只安装 desktop 发行包；不从三个源码目录分别覆盖运行文件。
