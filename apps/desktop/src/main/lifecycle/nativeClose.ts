import type { BrowserWindow } from "electron";
import type { ActiveTaskSummary, CloseAction, LifecycleController } from "./controller";

interface CloseEvent {
  preventDefault(): void;
}

interface CloseWindow {
  on(event: "close", listener: (event: CloseEvent) => void): unknown;
  isDestroyed?(): boolean;
}

export interface NativeCloseHandlerDeps {
  win: CloseWindow;
  lifecycle: LifecycleController;
  prompt: (win: BrowserWindow, task: ActiveTaskSummary) => Promise<CloseAction>;
  logger: { info(message: string): void; error(message: string): void };
}

/**
 * Keep the native close decision attached to the still-live main window.
 * `before-quit` happens too late for a window-close initiated shutdown: the
 * last BrowserWindow has already been destroyed at that point.
 */
export function installNativeCloseHandler({ win, lifecycle, prompt, logger }: NativeCloseHandlerDeps): void {
  win.on("close", (event) => {
    const state = lifecycle.getState();
    logger.info(`主窗口 close：approved=${state.approvedQuit} flow=${state.shutdownFlowRunning}`);
    if (state.approvedQuit || state.shutdownFlowRunning) {
      return;
    }

    event.preventDefault();
    void (async () => {
      try {
        const request = await lifecycle.requestClose();
        logger.info(`主窗口 close 请求结果：requiresAction=${request.requiresAction} task=${request.activeTask?.task_id ?? "none"}`);
        if (!request.requiresAction || !request.activeTask) {
          return;
        }
        const action = await prompt(win as BrowserWindow, request.activeTask);
        await lifecycle.selectCloseAction(action);
      } catch (error) {
        logger.error(`关闭流程异常：${(error as Error).message}`);
        lifecycle.reset();
      }
    })();
  });
}
