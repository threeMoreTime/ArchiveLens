/**
 * 只允许回到应用自身入口。
 *
 * 开发环境允许同源 Vite 路由；生产 file: 页面只允许入口文件本身（可带 query/hash）。
 * 使用 URL 结构比较，避免字符串前缀把 localhost.evil 或任意 URL 误判为可信地址。
 */
export function isAllowedAppNavigation(candidateUrl: string, appEntryUrl: string): boolean {
  if (!appEntryUrl) return false;
  try {
    const candidate = new URL(candidateUrl);
    const entry = new URL(appEntryUrl);
    if (candidate.protocol !== entry.protocol) return false;
    if (entry.protocol === "file:") {
      return candidate.host === entry.host && candidate.pathname === entry.pathname;
    }
    return candidate.origin === entry.origin;
  } catch {
    return false;
  }
}
