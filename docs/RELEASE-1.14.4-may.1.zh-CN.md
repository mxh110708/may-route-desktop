# May Route 1.14.4-may.1

同步 sing-box **1.14.4 最新稳定版**，构建工具链升级为 Go **1.26.10**。上游基础版本改变，May 修订从 1 重新开始。

- 合入上游连接生命周期、嵌套代理组、URLTest、DNS 缓存过滤、拨号顺序以及 Windows 双栈／IPv6 相关修复。
- 保留 May 的入口故障切换、Windows 代理归属、独立服务身份和原生 VLESS XHTTP。
- XHTTP 适配新的会话预热与闲置连接管理，活动流继续完成；HTTP/2／HTTP/3 共享连接使用独立会话上下文。
- 通过 `core-source.json` 固定配套 May Core 的标签与提交，正式构建及 CI 同时核对；Dashboard 固定 gitlink 保持不变。

隔离验收包括 259 个桌面单元测试、Core 回归与竞态检查、47 个实际 XHTTP 场景、Vision／AnyTLS 及错误身份负例，以及真实 StartedService 的配置准备、确认故障后切换、重载和连接取消。公网及 WinDivert／SCM 环境用例的限制见[同步记录](UPSTREAM-SING-BOX-1.14.4-2026-11-25.zh-CN.md)。

Windows x64 安装器沿用既有 May 签名身份，配套 SHA-256 校验及来源记录。请通过应用内更新或手动下载安装包升级；发布不会自动安装、重载代理或改变系统代理／TUN。
