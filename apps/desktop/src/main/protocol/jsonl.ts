/**
 * JSONL 增量解析：处理 TCP/管道粘包与半行。
 *
 * Sidecar stdout 可能一次性返回多条消息（粘包）或一条消息分多次到达（半行）。
 * :class:`JsonLineReader` 维护内部缓冲，按 ``\n`` 切分完整行。
 */
export class JsonLineReader {
  private buffer = "";

  /** 投喂一段文本，对每个完整行调用回调。 */
  feed(chunk: string, onLine: (line: string) => void): void {
    this.buffer += chunk;
    let newlineIndex: number;
    while ((newlineIndex = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line.trim()) onLine(line);
    }
  }

  /** 残留的未完成行（测试与诊断用）。 */
  get pending(): string {
    return this.buffer;
  }
}
