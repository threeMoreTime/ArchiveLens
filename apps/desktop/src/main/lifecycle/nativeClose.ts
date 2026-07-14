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
 * 在主窗口仍然存活时完成关闭决策。
 * 对由窗口关闭触发的退出流程而言，before-quit 阶段可能已经无法取得最后一个窗口。
 */
export function installNativeCloseHandler({ win, lifecycle, prompt, logger }: NativeCloseHandlerDeps): void {
  win.on("close", (event) => {
    const state = lifecycle.getState();
    logger.info(`主窗口 close：approved=${state.approvedQuit} flow=${state.shutdownFlowRunning}`);
    if (state.approvedQuit) {
      return;
    }

    event.preventDefault();
    if (state.shutdownFlowRunning) {
      return;
    }

    void (async () => {
      try {
        const request = await lifecycle.requestClose();
        logger.info(
          `主窗口 close 请求结果：requiresAction=${request.requiresAction} task=${request.activeTask?.task_id ?? "none"}`,
        );
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
