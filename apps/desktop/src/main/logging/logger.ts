import { app } from "electron";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Electron Main 进程文件日志。
 *
 * 规则（见 docs/architecture.md §日志）：
 *
 * * 写入 ``userData/logs/``，与 Python ``engine.log`` 分离；
 * * 全部 UTF-8；
 * * stdout 协议流**不**进入日志；
 * * 不记录文档 OCR 全文 / 敏感环境变量。
 *
 * 懒初始化日志目录：模块加载时 ``app`` 可能尚未 ready，
 * 首次写入时才解析 ``userData`` 路径。
 */
class Logger {
  private _logDir?: string;

  private get logDir(): string {
    if (!this._logDir) {
      this._logDir = join(app.getPath("userData"), "logs");
      mkdirSync(this._logDir, { recursive: true });
    }
    return this._logDir;
  }

  private write(file: string, level: string, msg: string): void {
    const line = `[${new Date().toISOString()}] ${level.padEnd(5)} ${msg}\n`;
    try {
      appendFileSync(join(this.logDir, file), line, "utf-8");
    } catch {
      // 日志失败不得影响主流程。
    }
  }

  info(msg: string): void {
    this.write("app.log", "INFO", msg);
  }

  warn(msg: string): void {
    this.write("app.log", "WARN", msg);
  }

  error(msg: string): void {
    this.write("app.log", "ERROR", msg);
  }

  /** Python Sidecar stderr 输出（已是文本）。 */
  engine(chunk: string): void {
    const trimmed = chunk.replace(/\n+$/, "");
    if (!trimmed) return;
    const line = `[${new Date().toISOString()}] ${trimmed}\n`;
    try {
      appendFileSync(join(this.logDir, "engine.log"), line, "utf-8");
    } catch {
      // 忽略
    }
  }

  get logDirectory(): string {
    return this.logDir;
  }
}

export const logger = new Logger();
