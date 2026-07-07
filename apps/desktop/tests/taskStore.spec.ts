import { describe, it, expect, beforeEach } from "vitest";
import { useTaskStore } from "../src/renderer/src/stores/taskStore";

describe("taskStore 事件归并", () => {
  beforeEach(() => useTaskStore.getState().reset());

  it("新事件覆盖旧状态", () => {
    const s = useTaskStore.getState();
    s.applyEvent({ event: "task.started", task_id: "t1", sequence: 1 });
    expect(useTaskStore.getState().tasks.t1.status).toBe("running");
    s.applyEvent({ event: "task.paused", task_id: "t1", sequence: 2 });
    expect(useTaskStore.getState().tasks.t1.status).toBe("paused");
  });

  it("旧 sequence 不覆盖新 sequence", () => {
    const s = useTaskStore.getState();
    s.applyEvent({ event: "task.progress", task_id: "t1", sequence: 5, payload: { processed_pages: 50 } });
    s.applyEvent({ event: "task.progress", task_id: "t1", sequence: 3, payload: { processed_pages: 10 } });
    const t = useTaskStore.getState().tasks.t1;
    expect(t.processed_pages).toBe(50); // 旧 seq=3 被忽略
  });

  it("completed 后旧 progress 不改回 running", () => {
    const s = useTaskStore.getState();
    s.applyEvent({ event: "task.started", task_id: "t1", sequence: 1 });
    s.applyEvent({ event: "task.completed", task_id: "t1", sequence: 10, payload: { occurrence_count: 6 } });
    // 旧 progress（seq 5）不得改回 running
    s.applyEvent({ event: "task.progress", task_id: "t1", sequence: 5, payload: { processed_pages: 999 } });
    const t = useTaskStore.getState().tasks.t1;
    expect(t.status).toBe("completed");
    expect(t.processed_pages).not.toBe(999);
  });

  it("task.failed 设置 last_error", () => {
    const s = useTaskStore.getState();
    s.applyEvent({ event: "task.failed", task_id: "t1", sequence: 2, payload: { error: "boom" } });
    expect(useTaskStore.getState().tasks.t1.status).toBe("failed");
    expect(useTaskStore.getState().tasks.t1.last_error).toBe("boom");
  });

  it("无 task_id 的事件被忽略", () => {
    const s = useTaskStore.getState();
    s.applyEvent({ event: "engine.ready", sequence: 1 });
    expect(Object.keys(useTaskStore.getState().tasks)).toHaveLength(0);
  });
});
