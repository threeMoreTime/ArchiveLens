import { BrowserWindow, ipcMain } from "electron";
import { z } from "zod";
import type { SidecarManager } from "../sidecar/manager";
import type { LifecycleController } from "../lifecycle/controller";
import { getTrayState, restoreTrayWindow } from "../tray";

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

const inspectStateSchema = z.object({
  task: z.record(z.string(), z.unknown()),
  task_id: z.string().min(1),
  source_id: z.string().min(1),
  processed_page_ids: z.array(z.number().int().positive()),
  occurrence_ids: z.array(z.string().min(1)),
  checkpoint: z
    .object({
      task_id: z.string().min(1),
      source_id: z.string().min(1),
      last_completed_page: z.number().int().nonnegative(),
      next_page: z.number().int().positive(),
      processed_page_ids: z.array(z.number().int().positive()),
      worker_generation: z.number().int().nonnegative(),
      updated_at: z.string().min(1),
    })
    .nullable(),
  events: z.array(
    z.object({
      event_id: z.string().min(1),
      task_id: z.string().min(1),
      source_id: z.string(),
      sequence: z.number().int().positive(),
      event_type: z.string().min(1),
      payload: z.record(z.string(), z.unknown()),
      worker_generation: z.number().int().nonnegative(),
      created_at: z.string().min(1),
    }),
  ),
  occurrence_count: z.number().int().nonnegative(),
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
    return inspectStateSchema.parse(raw);
  }

  ipcMain.handle("test.lifecycle.requestClose", async () => lifecycle.requestClose());
  ipcMain.handle("test.lifecycle.selectCloseAction", async (_event, payload) => {
    const { action } = z.object({ action: closeActionSchema }).parse(payload);
    return lifecycle.selectCloseAction(action);
  });
  ipcMain.handle("test.lifecycle.getState", async () => lifecycle.getState());

  ipcMain.handle("test.tray.getState", async () => getTrayState());
  ipcMain.handle("test.tray.restoreWindow", async () => ({ restored: restoreTrayWindow() }));

  ipcMain.handle("test.window.getState", async () => getMainWindowState());

  ipcMain.handle("test.engine.getPid", async () => ({ pid: sidecar.pid }));
  ipcMain.handle("test.sidecar.simulateCrash", async () => ({ ok: sidecar.simulateCrash() }));

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
