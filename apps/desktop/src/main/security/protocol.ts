import { net, protocol } from "electron";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isWithin } from "./paths";
import { logger } from "../logging/logger";

/**
 * 自定义本地资源协议 ``al-resource://``。
 *
 * Renderer **不得**直接拿到任意绝对路径；所有本地图片（出处页、字符小图）
 * 都通过该协议以「逻辑根 host + 相对路径」形式访问：
 *
 *     al-resource://<host>/<relative-path>
 *
 * Main 维护 host → 真实目录的映射，并校验相对路径不逃逸该目录。
 * 这样 Renderer 既看不到原始绝对路径，也无法读取任意文件。
 */

export const ASSET_SCHEME = "al-resource";

/** host → 真实目录 的映射。 */
const resourceRoots = new Map<string, string>();

export function registerResourceRoot(host: string, realDir: string): void {
  resourceRoots.set(host, realDir);
}

export function clearResourceRoots(): void {
  resourceRoots.clear();
}

/** 必须在 app ready **之前**调用。 */
export function registerPrivilegedSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ASSET_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        corsEnabled: true,
      },
    },
  ]);
}

/** 在 app ready **之后**调用，注册实际 handler。 */
export function registerAssetProtocol(): void {
  protocol.handle(ASSET_SCHEME, (request) => handleAssetRequest(request));
}

function handleAssetRequest(request: GlobalRequest): Response | Promise<Response> {
  try {
    const url = new URL(request.url);
    const host = url.hostname;
    const relPath = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    const base = resourceRoots.get(host);
    if (!base) {
      logger.warn(`al-resource 未知 host：${host}`);
      return new Response("forbidden", { status: 403 });
    }
    if (!relPath) {
      return new Response("missing path", { status: 400 });
    }
    const full = resolve(base, relPath);
    if (!isWithin(full, base)) {
      logger.warn(`al-resource 路径逃逸拦截：${relPath}`);
      return new Response("forbidden", { status: 403 });
    }
    return net.fetch(pathToFileURL(full).toString());
  } catch (err) {
    logger.error(`al-resource 协议错误：${(err as Error).message}`);
    return new Response("internal error", { status: 500 });
  }
}
