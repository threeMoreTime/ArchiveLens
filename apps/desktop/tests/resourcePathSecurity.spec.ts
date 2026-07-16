import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRealPathWithin } from "../src/main/security/paths";

const temporaryDirectories: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "archivelens-resource-path-"));
  temporaryDirectories.push(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryDirectories.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("real resource path containment", () => {
  it("accepts an existing file below the registered root", async () => {
    const root = temporaryRoot();
    const base = join(root, "workspace");
    const target = join(base, "pages", "page-1.png");
    mkdirSync(join(base, "pages"), { recursive: true });
    writeFileSync(target, "image");

    await expect(resolveRealPathWithin(target, base)).resolves.toMatchObject({
      status: "ok",
    });
  });

  it("rejects a directory link whose real target is outside the registered root", async () => {
    const root = temporaryRoot();
    const base = join(root, "workspace");
    const outside = join(root, "outside");
    mkdirSync(base);
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(outside, join(base, "linked"), process.platform === "win32" ? "junction" : "dir");

    await expect(resolveRealPathWithin(join(base, "linked", "secret.txt"), base)).resolves.toEqual({
      status: "escaped",
    });
  });

  it("reports missing targets without exposing filesystem errors", async () => {
    const root = temporaryRoot();
    const base = join(root, "workspace");
    mkdirSync(base);

    await expect(resolveRealPathWithin(join(base, "missing.png"), base)).resolves.toEqual({
      status: "missing",
    });
  });
});
