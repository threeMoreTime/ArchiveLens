import { BrowserWindow, ipcMain } from "electron";
import { z } from "zod";
import type { SidecarManager } from "../sidecar/manager";
import type { LifecycleController } from "../lifecycle/controller";
import { getTrayState, restoreTrayWindow } from "../tray";
import { TaskInspectStateResultSchema } from "@shared/index";

const closeActionSchema = z.enum([
  "minimize",
  "cancel",
  "pause_and_quit",
  "stop_and_quit",
  "continue_waiting",
  "force_quit",
]);

const taskIdSchema = z.object({
  task_id: z.string().min(1),
});

function getMainWindowState() {
  const win = BrowserWindow.getAllWindows()[0] ?? null;
  return {
    exists: win !== null,
    visible: win?.isVisible() ?? false,
    focused: win?.isFocused() ?? false,
    minimized: win?.isMinimized() ?? false,
  };
}

export function registerE2eHandlers(sidecar: SidecarManager, lifecycle: LifecycleController): void {
  if (process.env["ARCHIVELENS_E2E"] !== "1") {
    return;
  }

  async function inspectTask(task_id: string) {
    const raw = await sidecar.call("tasks.inspectState", { task_id });
    return TaskInspectStateResultSchema.parse(raw);
  }

  ipcMain.handle("test.lifecycle.requestClose", async () => lifecycle.requestClose());
  ipcMain.handle("test.lifecycle.selectCloseAction", async (_event, payload) => {
    const { action } = z.object({ action: closeActionSchema }).parse(payload);
    return lifecycle.selectCloseAction(action);
  });
  ipcMain.handle("test.lifecycle.getState", () => lifecycle.getState());

  ipcMain.handle("test.tray.getState", () => getTrayState());
  ipcMain.handle("test.tray.restoreWindow", () => ({ restored: restoreTrayWindow() }));

  ipcMain.handle("test.window.getState", () => getMainWindowState());

  ipcMain.handle("test.engine.getPid", () => ({ pid: sidecar.pid }));
  ipcMain.handle("test.sidecar.simulateCrash", () => ({ ok: sidecar.simulateCrash() }));

  ipcMain.handle("test.task.getState", async (_event, payload) => {
    const { task_id } = taskIdSchema.parse(payload);
    const state = await inspectTask(task_id);
    return state.task;
  });
  ipcMain.handle("test.task.getProcessedPageIds", async (_event, payload) => {
    const { task_id } = taskIdSchema.parse(payload);
    const state = await inspectTask(task_id);
    return { processed_page_ids: state.processed_page_ids, source_id: state.source_id };
  });
  ipcMain.handle("test.task.getOccurrenceIds", async (_event, payload) => {
    const { task_id } = taskIdSchema.parse(payload);
    const state = await inspectTask(task_id);
    return { occurrence_ids: state.occurrence_ids, source_id: state.source_id };
  });
  ipcMain.handle("test.task.getCheckpoint", async (_event, payload) => {
    const { task_id } = taskIdSchema.parse(payload);
    const state = await inspectTask(task_id);
    return { checkpoint: state.checkpoint, source_id: state.source_id };
  });
  ipcMain.handle("test.task.getEventSequence", async (_event, payload) => {
    const { task_id } = taskIdSchema.parse(payload);
    const state = await inspectTask(task_id);
    return {
      events: state.events.map((event) => ({
        sequence: event.sequence,
        type: event.event_type,
        worker_generation: event.worker_generation,
      })),
      source_id: state.source_id,
    };
  });
}
