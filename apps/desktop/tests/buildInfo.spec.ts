import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadDesktopBuildInfo } from "../src/main/buildInfo";

describe("desktop build metadata loader", () => {
  afterEach(() => {
    delete process.env["ARCHIVELENS_APP_INFO_PATH"];
  });

  it("reads explicit app info path when provided", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "archivelens-buildinfo-"));
    try {
      const metadataPath = path.join(dir, "app.info.json");
      writeFileSync(
        metadataPath,
        JSON.stringify({
          version: "0.1.0-alpha.11",
          git_commit: "abc".repeat(13) + "a",
          build_time: "2026-07-08T12:00:00.000Z",
          python_version: "3.11.9",
          node_version: "v24.3.0",
          electron_version: "31.4.0",
          protocol_version: 4,
        }),
        "utf-8",
      );
      process.env["ARCHIVELENS_APP_INFO_PATH"] = metadataPath;
      expect(loadDesktopBuildInfo()?.git_commit).toBe("abc".repeat(13) + "a");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
