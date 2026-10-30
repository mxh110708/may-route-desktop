# May Route 1.14.2-may.27

配套 Deploy v0.9.39 的原生 XHTTP 客户端更新。核心采用 May Core 提交 `9e40d486a0cb58d411ebaa2196d853b2aafa1dce`，完整项目源码和构建记录随 [May Core 发行](https://github.com/mxh110708/may-route-core/releases/tag/v1.14.2-may.xhttp20.0)提供。

- VLESS XHTTP 支持 stream-one、stream-up、packet-up、auto，以及固定实现中合法的 TLS HTTP/1.1／2／3、Reality HTTP/2 组合。
- 保留上下行分离的下载连接身份、Host、路径、高级 extra 和 XMux 配置；不通过启动第二个 Xray 常驻进程承载客户端。
- 配置准备、实际加载、探测、按实际使用入口的故障切换和核心网络重置识别原生 XHTTP，完整保留原参数。
- packet-up 缓冲改为按需增长并封顶。分配微基准有收益，但不将其当作整应用常驻内存或 CPU 的保证。

功能验收包含 47 个实际协议场景、相关竞态测试和 Route 配置／探测／故障切换生命周期。固定上游不成立的协议组合明确拒绝；公网/CDN 仅限已经实测的受控反向代理范围，不宣称任意网站或 CDN 通用。

本次沿用既有 May 安装身份与签名，并提供 SHA-256 校验。升级由用户在应用内或下载安装包手动执行；发布不表示已自动安装或改动代理配置。
