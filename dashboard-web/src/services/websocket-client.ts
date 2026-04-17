import type { WebSocketEvent } from '../models/types';

type EventHandler = (event: WebSocketEvent) => void;

export class WebSocketClient {
  private ws: WebSocket | null = null;
  private eventHandler: EventHandler | null = null;
  private port = 9100;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private totalConnectionsSinceSuccess = 0;
  private maxTotalConnections = 15;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _isConnected = false;
  private onConnectionChange: ((connected: boolean) => void) | null = null;

  get isConnected() { return this._isConnected; }

  connect(port: number, onEvent: EventHandler, onConnectionChange?: (connected: boolean) => void) {
    if (this.port === port && this._isConnected) return;
    this.port = port;
    this.eventHandler = onEvent;
    this.onConnectionChange = onConnectionChange ?? null;
    this.reconnectAttempts = 0;
    this.totalConnectionsSinceSuccess = 0;
    this.doConnect();
  }

  disconnect() {
    this.clearReconnect();
    this.ws?.close();
    this.ws = null;
    this.setConnected(false);
    this.eventHandler = null;
    this.onConnectionChange = null;
  }

  private doConnect() {
    this.clearReconnect();
    this.ws?.close();
    this.ws = null;

    // Connect directly to the watchdog server — Vite's HMR occupies the proxy
    // WebSocket slot on port 3000 and causes "closed before established" errors.
    // The watchdog server already has CORS headers, so direct connection works.
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${protocol}//127.0.0.1:${this.port}/api/ws/events`;

    this.totalConnectionsSinceSuccess++;
    const ws = new WebSocket(url);

    ws.onopen = () => {
      console.log('[WebSocket] Connected');
      this.setConnected(true);
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data) as unknown;
        this.reconnectAttempts = 0;
        this.totalConnectionsSinceSuccess = 0;
        this.eventHandler?.(data as WebSocketEvent);
      } catch (e) {
        console.warn('[WebSocket] Parse error:', e);
      }
    };

    ws.onclose = (ev) => {
      // Ignore clean close triggered by our own disconnect() call
      if (this.ws !== ws) return;
      this.setConnected(false);
      // Only log + reconnect if we were genuinely connected (not a stale close)
      if (ev.code !== 1000) {
        this.scheduleReconnect();
      }
    };

    ws.onerror = () => {
      // Error will be followed by onclose — don't double-log or double-reconnect
      if (this.ws !== ws) return;
      this.setConnected(false);
    };

    this.ws = ws;
  }

  private scheduleReconnect() {
    if (!this.eventHandler) return;
    this.reconnectAttempts++;
    if (this.reconnectAttempts > this.maxReconnectAttempts) return;
    if (this.totalConnectionsSinceSuccess >= this.maxTotalConnections) return;

    const delay = Math.min(30, Math.pow(2, this.reconnectAttempts)) * 1000;
    console.log(`[WebSocket] Reconnecting in ${delay / 1000}s (${this.reconnectAttempts}/${this.maxReconnectAttempts})`);
    this.reconnectTimer = setTimeout(() => this.doConnect(), delay);
  }

  private clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setConnected(value: boolean) {
    if (this._isConnected !== value) {
      this._isConnected = value;
      this.onConnectionChange?.(value);
    }
  }
}

export const wsClient = new WebSocketClient();
