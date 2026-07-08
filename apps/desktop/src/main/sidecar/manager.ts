import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { resolveEngineCommand, type EngineCommand } from "./paths";
import { JsonLineReader } from "../protocol/jsonl";
import { WireMessageSchema, type Response, type Event } from "@shared/index";
import { logger } from "../logging/logger";

const READY_TIMEOUT_MS = 15_000;
const DEFAULT_REQ_TIMEOUT_MS = 30_000;
const STDERR_TAIL_LINES = 200;

/** Sidecar 相关的结构化错误（code 与 IPC ErrorCode 对齐）。 */
export class EngineError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "EngineError";
  }
}

interface Pending {
  resolve: (r: Response) => void;
  reject: (e: EngineError) => void;
  timer: NodeJS.Timeout;
}

export type SidecarExitReason = "app_shutdown" | "forced_shutdown" | "unexpected_exit";

export interface SidecarExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string[];
  expected: boolean;
  reason: SidecarExitReason;
  kind: "expected_shutdown" | "forced_shutdown" | "unexpected_exit" | "crash";
}

export function classifySidecarExit(
  code: number | null,
  signal: NodeJS.Signals | null,
  requestedReason: SidecarExitReason | null,
): Pick<SidecarExitInfo, "expected" | "reason" | "kind"> {
  if (requestedReason === "app_shutdown" && (code === 0 || code === null) && signal === null) {
    return { expected: true, reason: "app_shutdown", kind: "expected_shutdown" };
  }
  if (requestedReason === "forced_shutdown") {
    return { expected: true, reason: "forced_shutdown", kind: "forced_shutdown" };
  }
  if (code === 0 && signal === null) {
    return { expected: false, reason: "unexpected_exit", kind: "unexpected_exit" };
  }
  return { expected: false, reason: "unexpected_exit", kind: "crash" };
}

/**
 * Python Sidecar 进程管理器。
 *
 * 职责（任务 §8.1）：
 * * spawn 启动（参数数组，``shell:false``）；
 * * JSONL 拆包与 schema 校验；
 * * 请求/响应按 ``request_id`` 关联，支持超时；
 * * ``engine.ready`` 事件握手；
 * * Sidecar 退出时所有未完成请求失败，并向 Renderer 广播。
 */
export class SidecarManager extends EventEmitter {
  private proc: ChildProcess | null = null;
  private reader = new JsonLineReader();
  private pending = new Map<string, Pending>();
  private ready = false;
  private starting: Promise<void> | null = null;
  private stderrTail: string[] = [];
  private readyWaiters: Array<() => void> = [];
  private requestedExitReason: SidecarExitReason | null = null;

  get isReady(): boolean {
    return this.ready;
  }

  get stderrTailSnapshot(): string[] {
    return [...this.stderrTail];
  }

  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    this.starting = this._start();
    return this.starting;
  }

  private async _start(): Promise<void> {
    const cmd = resolveEngineCommand();
    if (!cmd) {
      throw new EngineError("ENGINE_START_FAILED", "找不到 Python Engine 可执行文件");
    }
    this._spawn(cmd);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new EngineError(
            "ENGINE_START_FAILED",
            `Sidecar 在 ${READY_TIMEOUT_MS}ms 内未发出 engine.ready（stderr 见 engine.log）`,
          ),
        );
      }, READY_TIMEOUT_MS);
      this.readyWaiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private _spawn(cmd: EngineCommand): void {
    logger.info(`启动 Sidecar：${cmd.exe} ${cmd.args.join(" ")}`);
    this.proc = spawn(cmd.exe, cmd.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: cmd.env,
      windowsHide: true,
      shell: false, // 安全：参数数组，禁止拼接命令字符串
    });

    this.proc.stdout?.setEncoding("utf-8");
    this.proc.stdout?.on("data", (chunk: string) => {
      this.reader.feed(chunk, (line) => this.onLine(line));
    });

    this.proc.stderr?.setEncoding("utf-8");
    this.proc.stderr?.on("data", (chunk: string) => {
      logger.engine(chunk);
      for (const part of chunk.split("\n")) {
        if (part.trim()) this.stderrTail.push(part.trim());
      }
      if (this.stderrTail.length > STDERR_TAIL_LINES) {
        this.stderrTail.splice(0, this.stderrTail.length - STDERR_TAIL_LINES);
      }
    });

    this.proc.on("exit", (code, signal) => this.onExit(code, signal));
    this.proc.on("error", (err) => {
      logger.error(`Sidecar spawn error: ${err.message}`);
      this.onExit(-1, null);
    });
  }

  private onLine(line: string): void {
    let data: unknown;
    try {
      data = JSON.parse(line);
    } catch {
      // 无效 JSON：记录但不得崩溃主进程。
      logger.warn(`Sidecar 无效 JSON 已忽略：${line.slice(0, 200)}`);
      return;
    }
    const parsed = WireMessageSchema.safeParse(data);
    if (!parsed.success) {
      logger.warn(`Sidecar 消息 schema 不符：${parsed.error.issues[0]?.message ?? "unknown"}`);
      return;
    }
    const msg = parsed.data;

    if ("event" in msg) {
      this.handleEvent(msg);
      return;
    }
    this.handleResponse(msg);
  }

  private handleEvent(event: Event): void {
    if (event.event === "engine.ready") {
      this.markReady();
    }
    this.emit("event", event);
  }

  private handleResponse(resp: Response): void {
    const requestId = resp.request_id;
    if (requestId === null) {
      // ErrorResponse 允许 request_id 为 null（例如无效 JSON 场景）。
      const code = !resp.ok ? resp.error.code : "unknown";
      logger.warn(`Sidecar 收到无 request_id 的错误响应：${code}`);
      return;
    }
    const pending = this.pending.get(requestId);
    if (!pending) {
      logger.warn(`Sidecar 未知 request_id：${requestId}`);
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.resolve(resp);
  }

  private markReady(): void {
    if (this.ready) return;
    this.ready = true;
    logger.info("Sidecar 就绪（engine.ready）");
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w();
  }

  /** 发起一次请求，关联响应；超时拒绝。 */
  request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = DEFAULT_REQ_TIMEOUT_MS,
  ): Promise<Response> {
    if (!this.proc?.stdin) {
      return Promise.reject(new EngineError("ENGINE_CRASHED", "Sidecar 未运行"));
    }
    const request_id = randomUUID();
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(request_id)) {
          reject(new EngineError("IPC_TIMEOUT", `${method} 超时 ${timeoutMs}ms`));
        }
      }, timeoutMs);
      this.pending.set(request_id, { resolve, reject, timer });
      const line = JSON.stringify({ protocol_version: 1, request_id, method, params });
      this.proc!.stdin!.write(line + "\n", "utf-8");
    });
  }

  /** 便捷调用：解析成功响应 result，错误响应抛 EngineError。 */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    const resp = await this.request(method, params, timeoutMs);
    if (!resp.ok) {
      throw new EngineError(resp.error.code, resp.error.message);
    }
    return resp.result as T;
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const classification = classifySidecarExit(code, signal, this.requestedExitReason);
    const line = `Sidecar 退出 code=${code} signal=${signal} reason=${classification.reason} kind=${classification.kind}`;
    if (classification.expected) {
      logger.info(line);
    } else if (classification.kind === "unexpected_exit") {
      logger.warn(line);
    } else {
      logger.error(line);
    }
    this.requestedExitReason = null;
    this.ready = false;
    this.starting = null;
    this.proc = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new EngineError("ENGINE_CRASHED", `Sidecar 退出（code=${code}）`));
    }
    this.pending.clear();
    this.emit("exit", {
      code,
      signal,
      stderrTail: [...this.stderrTail],
      expected: classification.expected,
      reason: classification.reason,
      kind: classification.kind,
    } satisfies SidecarExitInfo);
  }

  /** 优雅停止：关闭 stdin，等待退出后强制 kill。 */
  async stop(reason: SidecarExitReason = "app_shutdown"): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.ready = false;
    this.requestedExitReason = reason;
    logger.info(`Sidecar stop begin pid=${proc.pid ?? "unknown"} reason=${reason}`);
    if (reason === "app_shutdown" && this.proc?.stdin) {
      try {
        await this.call("app.shutdown", {}, 3000);
        logger.info(`Sidecar app.shutdown acknowledged pid=${proc.pid ?? "unknown"}`);
      } catch (error) {
        logger.warn(`Sidecar app.shutdown failed pid=${proc.pid ?? "unknown"} error=${String(error)}`);
      }
    }
    try {
      proc.stdin?.end();
      logger.info(`Sidecar stop stdin.end sent pid=${proc.pid ?? "unknown"}`);
    } catch {
      // 忽略
    }
    await new Promise<void>((resolve) => {
      const forceKill = () => {
        if (!proc.pid) {
          logger.warn("Sidecar force-kill skipped because pid is missing");
          resolve();
          return;
        }
        logger.warn(`Sidecar force-kill pid=${proc.pid} reason=${reason}`);
        if (process.platform === "win32") {
          execFile("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true }, () => undefined);
          return;
        }
        try {
          proc.kill("SIGKILL");
        } catch {
          resolve();
        }
      };
      const forceKillTimer = setTimeout(() => {
        forceKill();
      }, 3000);
      proc.once("exit", () => {
        clearTimeout(forceKillTimer);
        logger.info(`Sidecar stop observed exit pid=${proc.pid ?? "unknown"} reason=${reason}`);
        resolve();
      });
    });
  }

  simulateCrash(): boolean {
    if (!this.proc) {
      return false;
    }
    this.requestedExitReason = null;
    return this.proc.kill();
  }
}
