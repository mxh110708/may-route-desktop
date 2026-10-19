export const DESKTOP_LANGUAGES = ["en", "zh-Hans"] as const;
export type DesktopLanguage = (typeof DESKTOP_LANGUAGES)[number];

export const DESKTOP_TRANSLATIONS = {
  "Start Service": "启动服务",
  "Stop Service": "停止服务",
  "Service starting...": "服务正在启动…",
  "Service stopping...": "服务正在停止…",
  "Routing Mode": "路由模式",
  "Rule": "规则",
  "Global": "全局",
  "Direct": "直连",
  "System Proxy": "系统代理",
  "TUN Mode": "TUN 模式",
  "Reload profile": "重新加载当前配置",
  "More": "更多",
  "Connections": "连接",
  "Logs": "日志",
  "Settings": "设置",
  "Open data directory": "打开数据目录",
  "Unavailable": "暂不可用",
  "Start": "启动",
  "Stop": "停止",
  "Service": "服务",
  "System HTTP Proxy": "系统 HTTP 代理",
  "Enabled": "已启用",
  "This Computer": "本机",
  "Profiles": "配置",
  "Profile": "配置",
  "New Profile": "新建配置",
  "Name": "名称",
  "Type": "类型",
  "Local": "本地",
  "Remote": "远程",
  "URL": "URL",
  "Auto Update": "自动更新",
  "Auto Update Interval": "自动更新间隔",
  "Last Updated": "最后更新",
  "Edit": "编辑",
  "Rename": "重命名",
  "Delete": "删除",
  "Copy": "复制",
  "Paste": "粘贴",
  "Share": "分享",
  "Import": "导入",
  "Export": "导出",
  "Check": "检查",
  "Format": "格式化",
  "Save": "保存",
  "Update": "更新",
  "Create": "创建",
  "Cancel": "取消",
  "Move Up": "上移",
  "Move Down": "下移",
  "Done": "完成",
  "No profiles": "没有配置",
  "No profile selected": "未选择配置",
  "Open": "打开",
  "Quit": "退出",
  "Group": "分组",
  "Close All Connections": "关闭所有连接",
  "URLTest All": "全部测速",
  "URLTest": "测速",
  "Start At Login": "开机启动",
  "Real-time Speed": "实时速率",
  "Disabled": "已禁用",
  "Unified": "统一",
  "Import Remote Profile": "导入远程配置",
  "Service Setup": "服务安装",
  "Connecting...": "连接中…",
  "Retry": "重试",
  "The sing-box service is not installed": "sing-box 服务未安装",
  "The sing-box service is not running": "sing-box 服务未运行",
  "Incompatible service version": "服务版本不兼容",
  "Install": "安装",
  "Upgrade": "升级",
} as const;

export type DesktopMessageKey = keyof typeof DESKTOP_TRANSLATIONS;

export function translateDesktop(language: DesktopLanguage, key: DesktopMessageKey): string {
  return language === "en" ? key : DESKTOP_TRANSLATIONS[key];
}

export function desktopLanguageFromLocale(locale: string): DesktopLanguage {
  return /^zh(?:[-_]|$)/iu.test(locale) ? "zh-Hans" : "en";
}

/** Keep old explicit choices deterministic when their translations are removed. */
export function preferredDesktopLanguage(preference: unknown, systemLocale: string): DesktopLanguage {
  if (preference === "en" || preference === "zh-Hans" || preference === "zh-Hant" || preference === "fa" || preference === "ru") {
    return desktopLanguageFromLocale(preference);
  }
  return desktopLanguageFromLocale(systemLocale);
}
