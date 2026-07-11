import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { BuildMetadata } from "@shared/index";

export function loadDesktopBuildInfo(): BuildMetadata | null {
  const explicit = process.env["ARCHIVELENS_APP_INFO_PATH"];
  const resourcesPath = typeof process.resourcesPath === "string" ? join(process.resourcesPath, "app.info.json") : undefined;
  const candidatePaths = [
    explicit,
    resourcesPath,
    join(__dirname, "app.info.json"),
    join(process.cwd(), "apps", "desktop", "app.info.json"),
  ].filter((value): value is string => Boolean(value));
  for (const candidatePath of candidatePaths) {
    try {
      const payload = JSON.parse(readFileSync(candidatePath, "utf-8"));
      if (payload && typeof payload === "object") {
        return payload as BuildMetadata;
      }
    } catch {
      continue;
    }
  }
  return null;
}
