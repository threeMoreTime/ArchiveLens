import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const page = (name: string) => readFileSync(
  resolve(__dirname, `../src/renderer/src/pages/${name}`),
  "utf-8",
);

describe("renderer state consistency", () => {
  it("registers the task resource root before loading review results", () => {
    const reviewPage = page("ReviewPage.tsx");
    expect(reviewPage).toContain('const [readyTaskId, setReadyTaskId] = useState("")');
    expect(reviewPage).toContain("if (readyTaskId !== taskId) return");
    expect(reviewPage).toContain("setReadyTaskId(taskId)");
  });

  it("offers every persisted task state in the task-center filter", () => {
    const taskCenter = page("TaskCenter.tsx");
    for (const status of [
      "draft", "queued", "starting", "running", "pausing", "paused", "resuming",
      "recoverable", "stopping", "stale", "completed", "failed", "cancelled",
    ]) {
      expect(taskCenter).toContain(`<option value="${status}">`);
    }
  });

  it("does not offer a duplicate cancel action while cancellation is in progress", () => {
    expect(page("TaskPage.tsx")).toContain('["cancelled", "completed", "failed", "stopping"]');
  });
});
