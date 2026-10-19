# GPU 进程 CPU 偏高的复核

## 结论

先前根据 `Get-Process.TotalProcessorTime` 计算出的 GPU 进程 CPU 大幅增加，不能作为源码性能回退的证据。新一轮在同一隔离运行中同时记录 Chromium 周期计数、原 Windows 时间计数与 GPU 线程跟踪：大幅增高只出现在旧计时口径，对应的实际线程工作量没有同步增加。

这不是关闭硬件加速获得的结果。测试仍使用 Electron 43.4.1 / Chromium 150.0.7871.224，正常硬件加速；没有修改正式客户端 GPU 参数。

## 直接对照

以下为大致相同的启动稳定区间，单核心为 100%。Chromium 数值取每秒时间线的稳定区间，旧数值取相邻首末 CIM 样本；边界相差不足一个采样间隔，因此不将两者的小差值作为性能差异。

| 隔离运行 | 旧 Windows 时间计数 | Chromium 周期计数 |
| --- | ---: | ---: |
| 基线渲染器，跟踪第 2 轮 | 0.86% | 1.76% |
| 当前渲染器，跟踪第 2 轮 | 0.38% | 1.82% |
| 当前渲染器，后台节流开启 | 11.43% | 1.83% |

旧口径既可低估也可高估。最后一行约六倍的偏差在同一次运行中出现；不能把 11.43% 直接解释为产品工作量增加。也没有将该样本当作“离群值”删除。

Chromium 对本机这类支持恒定速率 TSC 的 x86 平台，通过 `QueryProcessCycleTime` 和校准时钟计算累计 CPU；`GetProcessTimes` 是它明确区分的低精度回退路径。实现和初次校准要求见 [对应版本官方源码](https://raw.githubusercontent.com/chromium/chromium/150.0.7871.224/base/process/process_metrics_win.cc)。初次校准需要间隔至少 50 ms 的调用；本轮版本矩阵只使用第二至第四个样本计算 CPU，排除第一次可能仍走回退路径的读数。后续单项测试还在正式采样前预热这项计数。

## 线程跟踪

两组约 35 秒的跟踪都出现约 8,500 次 `WinVSyncProvider::GetVSyncIntervalIfAvailable`，约为 240 次/秒，主要来自 Chromium 的 `GpuVSyncThread`。对应的该线程根任务 CPU 时间约 274/291 ms，未出现与旧读数成比例的增长。绘制与光栅任务没有发生数量级增加。

实际存在的垂直同步开销仍应计入 GPU 进程 CPU。这里并未证明 GPU 进程没有任何 CPU 消耗，也未测量显卡硬件利用率。

检查还发现原隐藏测试统一设置 `backgroundThrottling:false`，与正式主窗口后台设置不同。补测改为后台启用正式节流，并保留强制关闭节流的跟踪作对照。单独改变这项设置没有消除旧时间计数异常，因此它不是完整解释；真正支持计时口径问题的证据是同次运行的两套 CPU 计数和线程跟踪。

## 后续测量规则

- Windows 私有工作集仍取同一套内存计数，GPU CPU 口径的问题不能用来否认内存上升。
- Electron 进程树 CPU 用完成校准的 `app.getAppMetrics().cpu.cumulativeCPUUsage` 差值；旧 Windows 时间计数保留为诊断附件。
- 测试代理后端不在 Electron 周期计数中，CPU 表明确排除它，不把两种计时方法混加。
- 隐藏后台采用正式节流配置；前台仍为不可见隔离窗口的可见性模拟，结果不等同实际桌面前台跑分。
- 历史性能文档中基于旧计时口径的 CPU 改善百分比降为历史记录，不用于当前保留决策。内存数据、RPC 次数和对象释放记录分别判断。

原始记录在工作区 `.codex-tmp/route-individual-audit-20261019/`：`trace-*.trace.json`、`native-optimized-3.trace.json`、对应时间线 JSON 及 `release-summary.json`。未控制鼠标、改变正式网络或替换现用安装。
