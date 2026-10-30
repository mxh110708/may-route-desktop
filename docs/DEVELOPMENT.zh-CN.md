# May Route 开发与配套构建

本仓库负责最终桌面包；Dashboard 与 Core 是各自独立仓库。普通用户下载 Release，开发者才需要下面的工具和目录。

## 来源与版本

| 输入 | 当前位置与作用 |
| --- | --- |
| 桌面 | 当前仓库 custom-main，安装器、Electron、Windows 代理与故障切换。 |
| Dashboard | `dashboard/` 子模块，固定 gitlink；不能用分支最新值替换已记录提交。 |
| Core | 同级 `../sing-box` 的 May 核心源码；构建脚本核对选定版本。 |
| 上游版本 | `version.json`，当前 1.14.2，Go 固定 `go1.26.8`。 |
| May 修订 | `custom-version.json`，当前 26，组合成 1.14.2-may.26。 |
| JS 工具 | `package.json` 固定 Node 26.7.0、pnpm 11.19.0，使用仓库锁文件。 |

不要把 May Monitor 的 Go 1.27.3 工具链要求套到 Route。上游模块路径、协议名和图标来源保持技术与许可证身份，不随品牌字符串批量替换。

## 开发与验证

从桌面根目录安装固定依赖，再按脚本准备子模块与生成物：

```bash
pnpm install --frozen-lockfile
pnpm generate
pnpm typecheck
pnpm build
```

`generate` 和依赖安装会改变生成物／本地状态，不是只读检查；运行前先核对工具链和工作树。开发模式可用 `pnpm dev`，使用隔离数据，不默认接入生产配置。

按改动选择已有专项命令：

| 改动 | 检查 |
| --- | --- |
| 运行配置、端口、规则 | `pnpm test:runtime-config`、`pnpm test:proxy-ports`、`pnpm test:public-rules` |
| 系统代理和故障切换 | `pnpm test:system-proxy-recovery`，编辑 UI 另用 `pnpm test:priority-editor:electron` |
| 更新 | `pnpm test:update-source`，实际网络栈另用 `pnpm test:update-connection:electron` |
| 托盘、后台与按需加载 | 对应 `test:tray-*`、`test:background-idle`、`test:renderer-loading` |
| 字体／语言 | `pnpm test:interface-fonts`、`pnpm test:localization` |
| 安装／卸载／快捷方式 | 对应 `test:installer-*`，在明确隔离的 QA 范围运行 |

文档变更只需链接、示例、源码合同和秘密检查，不要求重新安装桌面、切换代理或重跑资源长测。解析／单元测试、隔离 Electron、真实安装、四场景资源测量各有证据边界。

## 打包与更新

配套打包入口为 `pnpm package:custom:win`；正式本地签名流程见 `scripts/build-custom-release.ps1` 和[实现说明](../CUSTOM.md)。预先核对脚本参数、可移植工具链、核心来源和隔离输出目录；不要把开发包当作正式更新附件。

签名证书和口令存于仓库外，CI 不接收签名秘密。正式更新检查固定 May 仓库、精确版本安装器和相同签名身份。发布物从构建机器上传，不经其他 VPS 中转签名材料或二进制。

源码提交、推送、发行和本机安装是不同动作。纯文档更新不改 May 修订、依赖锁或 Dashboard／Web 的代码配套锁，也不替换已发包。

## 上游维护

第二十轮未发行 Core 源码已扩展 VLESS TLS／Reality XHTTP：四种模式、合法 HTTP/1.1／2／3、独立下载身份、元数据／填充与 XMux。桌面运行配置准备层保留完整出站；`tests/xhttp-runtime.ts` 与 Core `tests/xhttp-lifecycle.py` 联合验证真实 StartedService 的加载、按需探测、确认故障后切换和重载取消。参数、连接池策略及资源边界见同级 Core 的 `docs/MAY-XHTTP.zh-CN.md`。使用匹配核心构建，不从当前已安装版本推断支持；未新增第二常驻核心、修改 Dashboard gitlink 或切换本机系统代理／TUN。

按需选择官方提交审查和适配。`scripts/sync-upstream.ps1` 会 fetch、rebase 并更新子模块指针，必须在干净且有恢复点的工作树中明确执行，遇冲突停止。它不是文档检查命令，也不意味着已授权改写远端历史。

同步后重新核对功能差异、许可、版本、三个仓库的来源和实际支持平台。不能把上游增加的 Linux／核心协议支持直接写成 May Windows 产品已完成部署闭环。
