import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendRotatingLog } from "../src/main/logging/logger";

const temporaryDirectories: string[] = [];

function temporaryLogPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "archivelens-log-rotation-"));
  temporaryDirectories.push(dir);
  return join(dir, "app.log");
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("bounded log retention", () => {
  it("appends without rotation while the UTF-8 byte limit is not exceeded", () => {
    const filePath = temporaryLogPath();
    writeFileSync(filePath, "1234", "utf-8");

    appendRotatingLog(filePath, "档\n", 10);

    expect(readFileSync(filePath, "utf-8")).toBe("1234档\n");
    expect(() => readFileSync(`${filePath}.1`, "utf-8")).toThrow();
  });

  it("moves the previous file to one backup before writing the new line", () => {
    const filePath = temporaryLogPath();
    writeFileSync(filePath, "12345678", "utf-8");

    appendRotatingLog(filePath, "档\n", 10);

    expect(readFileSync(`${filePath}.1`, "utf-8")).toBe("12345678");
    expect(readFileSync(filePath, "utf-8")).toBe("档\n");
  });

  it("replaces an older backup on the next rotation", () => {
    const filePath = temporaryLogPath();
    writeFileSync(filePath, "old-current", "utf-8");
    writeFileSync(`${filePath}.1`, "obsolete-backup", "utf-8");

    appendRotatingLog(filePath, "new\n", 10);

    expect(readFileSync(`${filePath}.1`, "utf-8")).toBe("old-current");
    expect(readFileSync(filePath, "utf-8")).toBe("new\n");
  });
});
