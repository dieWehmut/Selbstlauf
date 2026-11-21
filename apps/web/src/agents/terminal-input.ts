/** Serializes keystrokes and pastes; a failed write never retries or delivers later queued text. */
export class TerminalInputQueue {
  private tail: Promise<void> = Promise.resolve();
  private failure: unknown = null;
  private disposed = false;

  constructor(private readonly write: (data: string) => Promise<void>) {}

  send(data: string, onAccepted?: (count: number) => void): Promise<void> {
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
          onAccepted?.(end - offset);
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

/** Retains acknowledged paste progress until its Enter succeeds, including across reconnects. */
export class TerminalSubmitter {
  private pending: { text: string; payload: string; accepted: number } | null = null;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly currentQueue: () => TerminalInputQueue | null,
    private readonly preparePaste: (text: string) => string,
  ) {}

  send(text: string): Promise<void> {
    const operation = this.tail.then(async () => {
      const queue = this.currentQueue();
      if (queue === null) throw new Error('终端已关闭。');
      queue.resetFailure();
      if (this.pending?.accepted === 0 && this.pending.text !== text) this.pending = null;
      if (this.pending !== null) {
        const previous = this.pending.text;
        await this.finish(queue);
        if (previous === text) return;
      }
      this.pending = { text, payload: this.preparePaste(text), accepted: 0 };
      await this.finish(queue);
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  private async finish(queue: TerminalInputQueue): Promise<void> {
    const pending = this.pending!;
    if (pending.accepted < pending.payload.length) {
      await queue.send(pending.payload.slice(pending.accepted), (count) => { pending.accepted += count; });
    }
    await queue.send('\r');
    this.pending = null;
  }
}
