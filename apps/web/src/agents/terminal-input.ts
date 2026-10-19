/** Serializes keystrokes and pastes; a failed write never retries or delivers later queued text. */
export class TerminalInputQueue {
  private tail: Promise<void> = Promise.resolve();
  private failure: unknown = null;
  private disposed = false;

  constructor(private readonly write: (data: string) => Promise<void>) {}

  send(data: string): Promise<void> {
    const operation = this.tail.then(async () => {
      if (this.disposed) throw new Error('终端已关闭。');
      if (this.failure !== null) throw this.failure;
      try {
        let offset = 0;
        while (offset < data.length) {
          if (this.disposed) throw new Error('终端已关闭。');
          // JSON can expand a control character to six bytes. Keep each body below the service limit.
          let end = Math.min(offset + 8192, data.length);
          if (end < data.length && /[\uD800-\uDBFF]/u.test(data[end - 1])) end -= 1;
          await this.write(data.slice(offset, end));
          offset = end;
        }
      } catch (error) { this.failure = error; throw error; }
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  resetFailure(): void { this.failure = null; }
  dispose(): void { this.disposed = true; }
}
