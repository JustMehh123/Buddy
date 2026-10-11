import type {
  ActionResult,
  HostEvent,
  HostEventType,
  PhoneActionMap,
  PhoneActionType,
  ToolName
} from '@buddy/protocol';
import { isHostEvent } from '@buddy/protocol';

/**
 * The phone's end of the live link.
 *
 * Wi-Fi drops, phones sleep, laptops close. This socket assumes all of that:
 * it reconnects with backoff, queues what you said while it was away, and asks
 * the host for a full state resync the moment it's back.
 */

export type ConnectionStatus = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline' | 'unauthorized';

export interface BuddySocketOptions {
  /** e.g. http://192.168.1.24:7777 or http://buddy.local:7777 */
  baseUrl: string;
  token: string;
  /** Injectable for tests / non-browser runtimes. */
  WebSocketImpl?: typeof WebSocket;
  fetchImpl?: typeof fetch;
  /** Called for every host event, before type-specific handlers. */
  onEvent?: (event: HostEvent) => void;
  onStatus?: (status: ConnectionStatus, detail?: string) => void;
  reconnect?: boolean;
  pingIntervalMs?: number;
}

type Handler<T extends HostEventType> = (payload: HostEvent<T>['payload'], event: HostEvent<T>) => void;

export class BuddySocket {
  private socket: WebSocket | null = null;
  private status: ConnectionStatus = 'idle';
  private handlers = new Map<HostEventType, Set<(payload: unknown, event: HostEvent) => void>>();
  private pendingActions = new Map<
    string,
    { resolve: (result: ActionResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private outbox: { type: PhoneActionType; payload: unknown; id?: string }[] = [];
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUser = false;
  private sequence = 0;
  private readonly options: Required<Pick<BuddySocketOptions, 'baseUrl' | 'token' | 'reconnect' | 'pingIntervalMs'>> &
    Omit<BuddySocketOptions, 'baseUrl' | 'token' | 'reconnect' | 'pingIntervalMs'>;

  constructor(options: BuddySocketOptions) {
    this.options = {
      reconnect: true,
      pingIntervalMs: 20_000,
      ...options,
      baseUrl: options.baseUrl.replace(/\/$/, '')
    };
  }

  get connectionStatus(): ConnectionStatus {
    return this.status;
  }

  get isOnline(): boolean {
    return this.status === 'online';
  }

  connect(): void {
    if (this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    this.closedByUser = false;
    this.setStatus(this.reconnectAttempts ? 'reconnecting' : 'connecting');

    const url = `${this.options.baseUrl.replace(/^http/, 'ws')}/ws?token=${encodeURIComponent(this.options.token)}`;
    const Impl = this.options.WebSocketImpl ?? WebSocket;
    let socket: WebSocket;
    try {
      socket = new Impl(url);
    } catch (error) {
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempts = 0;
      this.setStatus('online');
      // Anything said while the link was down, and then a full resync.
      this.send('get.state', {});
      for (const message of this.outbox.splice(0)) this.rawSend(message);
      this.startPing();
    };

    socket.onmessage = (message: MessageEvent) => {
      const data = typeof message.data === 'string' ? message.data : '';
      if (!data) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      if (!isHostEvent(parsed)) return;
      this.dispatch(parsed);
    };

    socket.onclose = (event: CloseEvent) => {
      this.stopPing();
      this.socket = null;
      if (event?.code === 4401 || event?.code === 4403) {
        this.setStatus('unauthorized', 'This phone is not paired with that computer any more.');
        return;
      }
      if (this.closedByUser) {
        this.setStatus('idle');
        return;
      }
      this.setStatus('offline');
      this.scheduleReconnect();
    };

    socket.onerror = () => {
      // `onclose` follows and owns the retry.
    };
  }

  close(): void {
    this.closedByUser = true;
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.socket?.close();
    this.socket = null;
    this.setStatus('idle');
  }

  /** Subscribe to a host event type. Returns an unsubscribe function. */
  on<T extends HostEventType>(type: T, handler: Handler<T>): () => void {
    const set = this.handlers.get(type) ?? new Set();
    set.add(handler as (payload: unknown, event: HostEvent) => void);
    this.handlers.set(type, set);
    return () => {
      set.delete(handler as (payload: unknown, event: HostEvent) => void);
    };
  }

  send<T extends PhoneActionType>(type: T, payload: PhoneActionMap[T], id?: string): void {
    const message = { type, payload, id, at: Date.now() };
    if (!this.isOnline) {
      // Keep the last handful; older chatter isn't worth replaying.
      this.outbox.push(message);
      if (this.outbox.length > 20) this.outbox.shift();
      if (!this.socket) this.connect();
      return;
    }
    this.rawSend(message);
  }

  /**
   * Ask the host to do something and wait for the receipt. Rejects on timeout so
   * Buddy never hangs silently mid-sentence.
   */
  request(
    tool: ToolName,
    args: Record<string, unknown> = {},
    options: { timeoutMs?: number; id?: string } = {}
  ): Promise<ActionResult> {
    const id = options.id ?? `act_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const timeoutMs = options.timeoutMs ?? 25_000;

    return new Promise<ActionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingActions.delete(id);
        reject(new Error(`${tool} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingActions.set(id, { resolve, reject, timer });
      this.send('action.request', { tool, args, id }, id);
    });
  }

  /** HTTP fallback for the rare case where the socket is wedged. */
  async requestOverHttp(
    tool: ToolName,
    args: Record<string, unknown> = {}
  ): Promise<ActionResult> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${this.options.baseUrl}/api/action`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.token}`
      },
      body: JSON.stringify({ tool, args })
    });
    if (!response.ok) throw new Error(`action failed: ${response.status}`);
    return (await response.json()) as ActionResult;
  }

  private dispatch(event: HostEvent): void {
    if (event.type === 'action.finished') {
      const result = event.payload as ActionResult;
      const pending = this.pendingActions.get(result.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingActions.delete(result.id);
        pending.resolve(result);
      }
    }
    if (event.type === 'pong') {
      this.sequence = 0;
    }
    this.options.onEvent?.(event);
    const set = this.handlers.get(event.type);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(event.payload, event);
      } catch (error) {
        // A bad handler must not kill the socket.
        console.error('[buddy] handler error', error);
      }
    }
  }

  private rawSend(message: { type: PhoneActionType; payload: unknown; id?: string }): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      this.outbox.push(message);
      return;
    }
    try {
      this.socket.send(JSON.stringify({ ...message, at: Date.now() }));
    } catch {
      this.outbox.push(message);
    }
  }

  private scheduleReconnect(): void {
    if (!this.options.reconnect || this.closedByUser) return;
    if (this.reconnectTimer) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(8000, 400 * 2 ** Math.min(this.reconnectAttempts, 5)) + Math.random() * 250;
    this.setStatus('reconnecting', `retrying in ${Math.round(delay)}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send('ping', { at: Date.now() });
    }, this.options.pingIntervalMs);
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  private setStatus(status: ConnectionStatus, detail?: string): void {
    if (this.status === status && !detail) return;
    this.status = status;
    this.options.onStatus?.(status, detail);
  }
}
