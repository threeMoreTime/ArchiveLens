/**
 * P1-8 Commit 4.1 — IPC AST helper 变异测试。
 *
 * 用临时 source text + 路径验证 parseEngineCallsFromSource / parseIpcMainHandlersFromSource，
 * 不修改真实仓库源码。每项断言错误信息包含文件和行列。
 */
import { describe, it, expect } from "vitest";
import {
  parseEngineCallsFromSource,
  parseIpcMainHandlersFromSource,
} from "./helpers/ipcContractAst";

const FILE = "fixture.ts";

describe("P1-8 Commit 4.1 — Engine 调用 AST 识别", () => {
  it("单行 sidecar.call(\"tasks.get\") 被识别", () => {
    const src = `const r = sidecar.call("tasks.get", {});`;
    const { literals, dynamicHits } = parseEngineCallsFromSource(src, FILE);
    expect(literals.map((l) => l.method)).toEqual(["tasks.get"]);
    expect(dynamicHits).toEqual([]);
  });

  it("跨行 sidecar.call(\\n\"tasks.get\") 被识别", () => {
    const src = `const r = sidecar.call(\n  "tasks.get",\n  params,\n);`;
    const { literals } = parseEngineCallsFromSource(src, FILE);
    expect(literals.map((l) => l.method)).toEqual(["tasks.get"]);
  });

  it("泛型 sidecar.call<Result>(\"tasks.get\") 被识别", () => {
    const src = `const r = sidecar.call<Result>("tasks.get", {});`;
    const { literals } = parseEngineCallsFromSource(src, FILE);
    expect(literals.map((l) => l.method)).toEqual(["tasks.get"]);
  });

  it("sidecar.request(\"tasks.get\") 被识别", () => {
    const src = `const r = sidecar.request("tasks.get", {});`;
    const { literals } = parseEngineCallsFromSource(src, FILE);
    expect(literals.map((l) => l.method)).toEqual(["tasks.get"]);
  });

  it("SidecarManager 内部 this.call(\"app.shutdown\") 被识别（receiver=this）", () => {
    const src = `class SidecarManager { call() { return this.call("app.shutdown", {}, 3000); } }`;
    const { literals } = parseEngineCallsFromSource(src, FILE);
    expect(literals).toHaveLength(1);
    expect(literals[0].method).toBe("app.shutdown");
    expect(literals[0].receiver).toBe("this");
  });

  it("foo.call(\"tasks.get\") 被忽略（非 sidecar/this receiver）", () => {
    const src = `foo.call("tasks.get");`;
    const { literals, dynamicHits } = parseEngineCallsFromSource(src, FILE);
    expect(literals).toEqual([]);
    expect(dynamicHits).toEqual([]);
  });

  it("字符串与注释中的 .call 被忽略", () => {
    const src = [
      `const s = "sidecar.call('tasks.get')"; // sidecar.call("comment")`,
      `/* sidecar.call("block") */ const x = 1;`,
    ].join("\n");
    const { literals, dynamicHits } = parseEngineCallsFromSource(src, FILE);
    expect(literals).toEqual([]);
    expect(dynamicHits).toEqual([]);
  });

  it("动态 sidecar.call(method) 被报告（含 file/line/column/receiver）", () => {
    const src = `const r = sidecar.call(method, {});`;
    const { literals, dynamicHits } = parseEngineCallsFromSource(src, FILE);
    expect(literals).toEqual([]);
    expect(dynamicHits).toHaveLength(1);
    expect(dynamicHits[0].receiver).toBe("sidecar");
    expect(dynamicHits[0].method).toBe("call");
    expect(dynamicHits[0].file).toBe(FILE);
    expect(dynamicHits[0].line).toBeGreaterThan(0);
    expect(dynamicHits[0].column).toBeGreaterThan(0);
  });

  it("SidecarManager.call 内 this.request(method) 内部转发被精确识别（含 enclosing）", () => {
    const src = `class SidecarManager {\n  call(m: string) { return this.request(m, {}, 3000); }\n}`;
    const { dynamicHits } = parseEngineCallsFromSource(src, FILE);
    expect(dynamicHits).toHaveLength(1);
    expect(dynamicHits[0].receiver).toBe("this");
    expect(dynamicHits[0].method).toBe("request");
    expect(dynamicHits[0].enclosingClass).toBe("SidecarManager");
    expect(dynamicHits[0].enclosingMethod).toBe("call");
  });

  it("第二处动态 manager 调用不能被宽泛放行（精确字段区分）", () => {
    // 模拟 SidecarManager 中另一处 this.request(method)（非 call 方法内）
    const src = `class SidecarManager {\n  call(m: string) { return this.request(m, {}, 3000); }\n  other(m: string) { return this.request(m); }\n}`;
    const { dynamicHits } = parseEngineCallsFromSource(src, FILE);
    expect(dynamicHits).toHaveLength(2);
    // 只有 enclosingMethod=call 的那处是允许的内部转发
    const allowed = dynamicHits.filter(
      (h) => h.receiver === "this" && h.method === "request" && h.enclosingClass === "SidecarManager" && h.enclosingMethod === "call",
    );
    const disallowed = dynamicHits.filter((h) => !(h.receiver === "this" && h.method === "request" && h.enclosingClass === "SidecarManager" && h.enclosingMethod === "call"));
    expect(allowed).toHaveLength(1);
    expect(disallowed).toHaveLength(1);
    expect(disallowed[0].enclosingMethod).toBe("other");
  });
});

describe("P1-8 Commit 4.1 — ipcMain.handle AST 识别", () => {
  it("字面量 channel 正常记录", () => {
    const src = `ipcMain.handle("tasks.get", async () => 1);`;
    const regs = parseIpcMainHandlersFromSource(src, FILE);
    expect(regs).toHaveLength(1);
    expect(regs[0].channel).toBe("tasks.get");
    expect(regs[0].channelIsLiteral).toBe(true);
    expect(regs[0].callbackPresent).toBe(true);
  });

  it("动态 channel 被记录为非法（channelIsLiteral=false）", () => {
    const src = `ipcMain.handle(channelVar, async () => 1);`;
    const regs = parseIpcMainHandlersFromSource(src, FILE);
    expect(regs).toHaveLength(1);
    expect(regs[0].channel).toBe(null);
    expect(regs[0].channelIsLiteral).toBe(false);
    expect(regs[0].file).toBe(FILE);
    expect(regs[0].line).toBeGreaterThan(0);
  });

  it("缺失 channel 被记录为非法", () => {
    const src = `ipcMain.handle();`;
    const regs = parseIpcMainHandlersFromSource(src, FILE);
    expect(regs).toHaveLength(1);
    expect(regs[0].channel).toBe(null);
    expect(regs[0].channelIsLiteral).toBe(false);
  });

  it("缺失 callback 被记录为非法（callbackPresent=false）", () => {
    const src = `ipcMain.handle("tasks.get");`;
    const regs = parseIpcMainHandlersFromSource(src, FILE);
    expect(regs).toHaveLength(1);
    expect(regs[0].callbackPresent).toBe(false);
  });

  it("local handler 中动态 Sidecar 调用被记录到 dynamicEngineMethods", () => {
    const src = `ipcMain.handle("app.getVersion", async () => sidecar.call(method));`;
    const regs = parseIpcMainHandlersFromSource(src, FILE);
    expect(regs).toHaveLength(1);
    expect(regs[0].dynamicEngineMethods).toHaveLength(1);
    expect(regs[0].dynamicEngineMethods[0].receiver).toBe("sidecar");
  });

  it("forwarded handler 多个 Engine method 被全部记录（可据此拒绝）", () => {
    const src = `ipcMain.handle("tasks.get", async () => { sidecar.call("tasks.get"); sidecar.call("tasks.list"); });`;
    const regs = parseIpcMainHandlersFromSource(src, FILE);
    expect(regs).toHaveLength(1);
    expect(regs[0].directEngineMethods).toEqual(["tasks.get", "tasks.list"]);
  });
});
