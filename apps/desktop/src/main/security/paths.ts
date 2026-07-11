import { resolve, sep } from "node:path";

/**
 * 路径白名单校验：判断 target 是否在 base 目录之内，防止 ``..`` 逃逸。
 *
 * 用于自定义资源协议、打开原始文件等所有“把本地路径暴露给 Renderer”的场合。
 */
export function isWithin(target: string, base: string): boolean {
  const t = resolve(target) + sep;
  const b = resolve(base) + sep;
  return t === b || t.startsWith(b);
}

/** 同时校验多个 base，命中任一即通过。 */
export function isWithinAny(target: string, bases: string[]): boolean {
  return bases.some((base) => isWithin(target, base));
}
