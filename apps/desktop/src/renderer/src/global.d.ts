export {};

// Preload 注入；只允许使用受审计的 ArchiveLensApi，不把任意 ipcRenderer/Node 能力带入 Renderer。
declare global {
  interface Window {
    archiveLens: import("../../preload/api").ArchiveLensApi;
  }
}
