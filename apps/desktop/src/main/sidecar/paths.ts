import { app } from "electron";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * 解析 Python Engine 可执行命令。
 *
 * 两种形态：
 *
 * 1. **开发模式**（``AL_ENGINE_DEV`` 指向 Python 解释器）：
 *    以 ``python -m archivelens_engine serve`` 启动，``PYTHONPATH`` 指向 ``engine/src``。
 *    便于改完 Python 立即生效，无需重新 PyInstaller 打包。
 *
 * 2. **生产模式**：``resources/engine/win-x64/archivelens-engine.exe``
 *    （PyInstaller one-folder 产物，Phase 7 由 electron-builder 放入 extraResources）。
 *
 * 禁止依赖开发机固定路径；开发模式从 cwd 向上探测 ``engine/src`` 与 tessdata。
 */
export interface EngineCommand {
  exe: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface BundledNativePaths {
  tesseractCmd: string;
  tessdataDir: string;
  djvuBinDir: string;
}

/** 生产包内原生组件的固定布局；不得回退到宿主 PATH。 */
export function resolveBundledNativePaths(resourcesRoot: string): BundledNativePaths {
  return {
    tesseractCmd: join(resourcesRoot, "native", "tesseract", "tesseract.exe"),
    tessdataDir: join(resourcesRoot, "native", "tesseract", "tessdata"),
    djvuBinDir: join(resourcesRoot, "native", "djvulibre"),
  };
}

/** 从 cwd 向上探测 ``engine/src`` 目录（开发期）。 */
export function findEngineSrc(maxUp = 6): string | null {
  let dir = process.cwd();
  for (let i = 0; i < maxUp; i++) {
    const candidate = join(dir, "engine", "src");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 从 cwd 向上探测开发期 tessdata（仅开发模式注入，生产模式由打包内 tessdata 提供）。 */
export function findTessdata(maxUp = 6): string | null {
  let dir = process.cwd();
  for (let i = 0; i < maxUp; i++) {
    const candidate = join(dir, ".tmp", "work", "tessdata");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function resolveEngineCommand(): EngineCommand | null {
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    // 强制 UTF-8，避免 Windows 默认 GBK 导致中文日志/协议乱码。
    PYTHONUNBUFFERED: "1",
    PYTHONIOENCODING: "utf-8",
    // Engine 工作目录（任务/DB/导出），由 Main 决定为 userData/engine。
    AL_WORKSPACE_ROOT: join(app.getPath("userData"), "engine"),
  };

  const devPython = process.env.AL_ENGINE_DEV;
  if (devPython) {
    const engineSrc = process.env.AL_ENGINE_SRC ?? findEngineSrc();
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    if (engineSrc) env.PYTHONPATH = engineSrc;
    const tessdata = process.env.AL_TESSDATA_DIR ?? findTessdata();
    if (tessdata) env.AL_TESSDATA_DIR = tessdata;
    return {
      exe: devPython,
      args: ["-m", "archivelens_engine", "serve"],
      env,
    };
  }

  // 生产模式：extraResources 内的 PyInstaller 产物。
  const prodRoot = app.isPackaged ? process.resourcesPath : join(__dirname, "..", "..");
  const prodExe = join(prodRoot, "engine", "win-x64", "archivelens-engine.exe");
  if (existsSync(prodExe)) {
    const native = resolveBundledNativePaths(prodRoot);
    return {
      exe: prodExe,
      args: ["serve"],
      env: {
        ...baseEnv,
        // 生产包只使用随包且经发布链校验的组件，避免宿主 PATH 或同名环境变量改变行为。
        AL_TESSERACT_CMD: native.tesseractCmd,
        AL_TESSDATA_DIR: native.tessdataDir,
        AL_DJVU_BIN_DIR: native.djvuBinDir,
        AL_NATIVE_SOURCE: "bundled",
        TESSDATA_PREFIX: native.tessdataDir,
      },
    };
  }
  return null;
}
