export {};

// Preload 注入；精确类型见 preload/api.ts。renderer 侧暂用宽类型以解耦构建边界。
declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    archiveLens: any;
  }
}
