type Listener = (data: unknown) => void;
interface OutputListener { data: Listener; connection: (online: boolean) => void }
interface OutputGroup { cursor: number; listeners: Set<OutputListener> }

/** Shared by the watchdog and every terminal in one page; reconnects replay from each session's cursor. */
class LiveSocket {
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private delay = 200;
  private readonly events = new Map<string, Set<Listener>>();
  private readonly outputs = new Map<string, OutputGroup>();

  subscribe(event: string, listener: Listener): () => void {
    const listeners = this.events.get(event) ?? new Set<Listener>();
    listeners.add(listener); this.events.set(event, listeners);
    this.connect();
    return () => { listeners.delete(listener); if (listeners.size === 0) this.events.delete(event); this.release(); };
  }

  output(id: string, listener: OutputListener): () => void {
    const group = this.outputs.get(id) ?? { cursor: 0, listeners: new Set<OutputListener>() };
    group.listeners.add(listener); this.outputs.set(id, group);
    this.connect();
    if (this.socket?.readyState === WebSocket.OPEN) {
      listener.connection(true);
      // A newly mounted terminal needs a full replay, even when another viewer already has this session open.
      this.send({ type: 'subscribe-output', id, after: 0 });
    }
    return () => {
      group.listeners.delete(listener);
      if (group.listeners.size === 0) { this.outputs.delete(id); this.send({ type: 'unsubscribe-output', id }); }
      this.release();
    };
  }

  private connect(): void {
    if (this.socket !== null || this.timer !== null) return;
    const url = new URL('/api/socket', window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(url.href);
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.delay = 200;
      for (const [id, group] of this.outputs) {
        for (const listener of group.listeners) listener.connection(true);
        this.send({ type: 'subscribe-output', id, after: group.cursor });
      }
    };
    socket.onmessage = (message) => {
      if (this.socket !== socket) return;
      try {
        const frame = JSON.parse(String(message.data)) as { event?: unknown; data?: unknown };
        if (typeof frame.event !== 'string') return;
        if (frame.event === 'output') {
          const output = frame.data as { session?: { id?: unknown }; offset?: unknown } | null;
          if (typeof output?.session?.id !== 'string') return;
          const group = this.outputs.get(output.session.id);
          if (group === undefined) return;
          for (const listener of group.listeners) listener.data(frame.data);
          if (Number.isSafeInteger(output.offset) && (output.offset as number) >= 0) group.cursor = output.offset as number;
        } else if (frame.event === 'agent-error') {
          const failure = frame.data as { id?: unknown } | null;
          for (const [id, group] of this.outputs) if (failure?.id === undefined || failure.id === id) {
            for (const listener of group.listeners) listener.connection(false);
          }
        } else {
          for (const listener of this.events.get(frame.event) ?? []) listener(frame.data);
        }
      } catch { /* A malformed message is not a state update. */ }
    };
    socket.onerror = () => socket.close();
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = null;
      for (const group of this.outputs.values()) for (const listener of group.listeners) listener.connection(false);
      if (this.events.size === 0 && this.outputs.size === 0) return;
      this.timer = setTimeout(() => { this.timer = null; this.connect(); }, this.delay);
      this.delay = Math.min(this.delay * 2, 5000);
    };
  }

  private send(message: unknown): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  private release(): void {
    if (this.events.size > 0 || this.outputs.size > 0) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }
}

const connection = new LiveSocket();
export function subscribeLiveEvent(event: string, listener: Listener): () => void { return connection.subscribe(event, listener); }
export function subscribeLiveOutput(id: string, data: Listener, online: (connected: boolean) => void): () => void {
  return connection.output(id, { data, connection: online });
}
