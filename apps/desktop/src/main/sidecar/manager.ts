import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { resolveEngineCommand, type EngineCommand } from "./paths";
import { JsonLineReader } from "../protocol/jsonl";
import {
  PROTOCOL_VERSION,
  TaskSearchEventPayloadSchema,
  WireMessageSchema,
  parseMethodResult,
  type Response,
  type Event,
} from "@shared/index";
import { logger } from "../logging/logger";
import { errorRegistry } from "../diagnostics/errorRegistry";

export const SIDECAR_READY_TIMEOUT_MS = 15_000;
const DEFAULT_REQ_TIMEOUT_MS = 30_000;
const STDERR_TAIL_LINES = 200;

/** Sidecar 相关的结构化错误（code 与 IPC ErrorCode 对齐）。 */
export class EngineError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "EngineError";
  }
}

interface Pending {
  resolve: (r: Response) => void;
  reject: (e: EngineError) => void;
  timer: NodeJS.Timeout;
}

interface ReadyWaiter {
  resolve: () => void;
  reject: (error: EngineError) => void;
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
  private readyWaiters: ReadyWaiter[] = [];
  private requestedExitReason: SidecarExitReason | null = null;
  private lastStartupError: EngineError | null = null;

  get isReady(): boolean {
    return this.ready;
  }

  get stderrTailSnapshot(): string[] {
    return [...this.stderrTail];
  }

  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  get startupErrorSnapshot(): EngineError | null {
    return this.lastStartupError;
  }

  async start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.proc && !this.ready) {
      return Promise.reject(
        this.lastStartupError
        ?? new EngineError("ENGINE_START_FAILED", "Sidecar 上一次启动尚未完成清理，请稍后重试"),
      );
    }
    this.lastStartupError = null;
    this.starting = this._start().catch((error) => {
      this.starting = null;
      throw error;
    });
    return this.starting;
  }

  private async _start(): Promise<void> {
    const cmd = resolveEngineCommand();
    if (!cmd) {
      throw new EngineError("ENGINE_START_FAILED", "找不到 Python Engine 可执行文件");
    }
    this._spawn(cmd);

    await new Promise<void>((resolve, reject) => {
      const waiter: ReadyWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => this.handleReadyTimeout(waiter), SIDECAR_READY_TIMEOUT_MS),
      };
      this.readyWaiters.push(waiter);
    });
  }

  private handleReadyTimeout(waiter: ReadyWaiter): void {
    const index = this.readyWaiters.indexOf(waiter);
    if (index < 0) return;
    this.readyWaiters.splice(index, 1);
    const error = new EngineError(
      "ENGINE_START_FAILED",
      `Sidecar 在 ${SIDECAR_READY_TIMEOUT_MS}ms 内未发出 engine.ready（stderr 见 engine.log）`,
    );
    this.lastStartupError = error;
    logger.error(error.message);
    errorRegistry.record({
      source: "sidecar",
      operation: "engine.ready",
      code: error.code,
      message: error.message,
      details: error.details,
    });
    waiter.reject(error);
    this.terminateProtocolFault();
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
      this.failProtocol(
        "wire_message",
        data,
        parsed.error.issues[0]?.message ?? "Sidecar message schema mismatch",
      );
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
    } else if (["task.created", "task.started", "task.resumed", "task.recoverable"].includes(event.event)) {
      const payload = TaskSearchEventPayloadSchema.safeParse(event.payload);
      if (!payload.success) {
        this.failProtocol("task_event", event, payload.error.issues[0]?.message ?? "Task event payload mismatch");
        return;
      }
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
    this.lastStartupError = null;
    logger.info("Sidecar 就绪（engine.ready）");
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
  }

  private failProtocol(stage: string, received: unknown, message: string): void {
    const actual =
      typeof received === "object" && received !== null && "protocol_version" in received
        ? (received as { protocol_version?: unknown }).protocol_version
        : undefined;
    const error = new EngineError("PROTOCOL_MISMATCH", "Engine protocol version is incompatible.", {
      expected: PROTOCOL_VERSION,
      actual,
      stage,
      validation: message,
    });
    this.lastStartupError = error;
    this.ready = false;
    for (const waiter of this.readyWaiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.readyWaiters = [];
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    logger.error(`Sidecar protocol mismatch stage=${stage} expected=${PROTOCOL_VERSION} actual=${String(actual)}`);
    errorRegistry.record({
      source: "sidecar",
      operation: `protocol:${stage}`,
      code: error.code,
      message: error.message,
      details: error.details,
    });
    this.emit("protocolError", error);
    this.terminateProtocolFault();
  }

  private terminateProtocolFault(): void {
    const proc = this.proc;
    if (!proc) return;
    this.requestedExitReason = "forced_shutdown";
    if (process.platform === "win32" && proc.pid) {
      execFile("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true }, () => undefined);
      return;
    }
    try {
      proc.kill("SIGKILL");
    } catch {
      // Exit handling will finish cleanup if the process already ended.
    }
  }

  /** 发起一次请求，关联响应；超时拒绝。 */
  request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = DEFAULT_REQ_TIMEOUT_MS,
  ): Promise<Response> {
    if (!this.proc?.stdin || (!this.ready && method !== "app.shutdown")) {
      return Promise.reject(new EngineError("ENGINE_CRASHED", "Sidecar 未运行"));
    }
    const request_id = randomUUID();
    const taskId = typeof params["task_id"] === "string" ? params["task_id"] : null;
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(request_id)) {
          const error = new EngineError("IPC_TIMEOUT", `${method} 超时 ${timeoutMs}ms`);
          errorRegistry.record({ source: "sidecar", operation: method, taskId, code: error.code, message: error.message });
          reject(error);
        }
      }, timeoutMs);
      this.pending.set(request_id, { resolve, reject, timer });
      const line = JSON.stringify({ protocol_version: PROTOCOL_VERSION, request_id, method, params });
      try {
        this.proc!.stdin!.write(line + "\n", "utf-8");
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(request_id);
        const engineError = new EngineError("ENGINE_CRASHED", `Sidecar request write failed: ${String(error)}`);
        errorRegistry.record({ source: "sidecar", operation: method, taskId, code: engineError.code, message: engineError.message });
        reject(engineError);
      }
    });
  }

  /** 便捷调用：解析成功响应 result，错误响应抛 EngineError。 */
  async call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
    const resp = await this.request(method, params, timeoutMs);
    if (!resp.ok) {
      errorRegistry.record({
        source: "engine",
        operation: method,
        taskId: typeof params["task_id"] === "string" ? params["task_id"] : null,
        code: resp.error.code,
        message: resp.error.message,
        details: resp.error.details,
      });
      throw new EngineError(resp.error.code, resp.error.message, resp.error.details);
    }
    try {
      return parseMethodResult(method, resp.result) as T;
    } catch (error) {
      this.failProtocol("response_result", resp, String(error));
      throw this.lastStartupError ?? new EngineError("PROTOCOL_MISMATCH", "Engine response schema mismatch");
    }
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
    if (!classification.expected) {
      errorRegistry.record({
        source: "sidecar",
        operation: "sidecar.exit",
        code: classification.kind === "crash" ? "ENGINE_CRASHED" : "ENGINE_STOPPED",
        message: line,
        details: { code, signal, kind: classification.kind, stderr_tail: this.stderrTail.slice(-20) },
      });
    }
    this.requestedExitReason = null;
    this.ready = false;
    this.starting = null;
    this.proc = null;
    if (this.readyWaiters.length > 0) {
      const startupError = this.lastStartupError ?? new EngineError("ENGINE_CRASHED", `Sidecar exited before ready (code=${code})`);
      for (const waiter of this.readyWaiters) {
        clearTimeout(waiter.timer);
        waiter.reject(startupError);
      }
      this.readyWaiters = [];
      this.lastStartupError = startupError;
    }
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
    const pid = proc.pid;
    const exitObserved = new Promise<void>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        resolve();
        return;
      }
      proc.once("exit", () => resolve());
    });
    const waitForExit = (timeoutMs: number): Promise<boolean> => new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void exitObserved.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    const forceTerminate = (): Promise<void> => new Promise((resolve) => {
      if (!pid) {
        resolve();
        return;
      }
      if (process.platform === "win32") {
        execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, timeout: 3000 }, (error) => {
          if (error && proc.exitCode === null) {
            logger.warn(`Sidecar taskkill failed pid=${pid} error=${error.message}`);
          }
          resolve();
        });
        return;
      }
      try {
        proc.kill("SIGKILL");
      } catch {
        // The exit listener will already have resolved if the process ended first.
      }
      resolve();
    });

    this.ready = false;
    this.requestedExitReason = reason;
    logger.info(`Sidecar stop begin pid=${pid ?? "unknown"} reason=${reason}`);
    if (reason === "app_shutdown" && this.proc?.stdin) {
      try {
        await this.call("app.shutdown", {}, 3000);
        logger.info(`Sidecar app.shutdown acknowledged pid=${pid ?? "unknown"}`);
      } catch (error) {
        logger.warn(`Sidecar app.shutdown failed pid=${pid ?? "unknown"} error=${String(error)}`);
      }
    }
    try {
      proc.stdin?.end();
      logger.info(`Sidecar stop stdin.end sent pid=${pid ?? "unknown"}`);
    } catch {
      // 忽略
    }
    if (await waitForExit(3000)) {
      logger.info(`Sidecar stop observed graceful exit pid=${pid ?? "unknown"} reason=${reason}`);
      return;
    }

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      logger.warn(`Sidecar force-kill attempt=${attempt} pid=${pid ?? "unknown"} reason=${reason}`);
      await forceTerminate();
      if (await waitForExit(5000)) {
        logger.info(`Sidecar stop confirmed exit after force-kill attempt=${attempt} pid=${pid ?? "unknown"}`);
        return;
      }
    }
    throw new EngineError("ENGINE_STOPPED", `Sidecar process ${pid ?? "unknown"} did not exit after repeated termination attempts`);
  }

  simulateCrash(): boolean {
    if (!this.proc) {
      return false;
    }
    this.requestedExitReason = null;
    return this.proc.kill();
  }
}
