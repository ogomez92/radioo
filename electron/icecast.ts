import * as net from 'net';
import * as tls from 'tls';
import { EventEmitter } from 'events';

export interface IcecastConfig {
  url: string;
  username: string;
  password: string;
  format: string;
  streamName: string;
}

const CONTENT_TYPES: Record<string, string> = {
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  aac: 'audio/aac',
  opus: 'audio/ogg; codecs=opus',
  flac: 'audio/flac',
};

export class IcecastClient extends EventEmitter {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private connected = false;
  private config: IcecastConfig | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalDisconnect = false;
  private reconnectAttempts = 0;
  private reconnecting = false;

  async connect(config: IcecastConfig): Promise<void> {
    this.config = config;
    this.intentionalDisconnect = false;

    const parsed = new URL(config.url);
    const useSSL = parsed.protocol === 'https:';
    const host = parsed.hostname;
    const port = parseInt(parsed.port) || (useSSL ? 443 : 8000);
    const mount = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '/stream';

    const target = `${host}:${port}${mount}`;
    const username = (config.username || 'source').trim();
    const password = config.password;

    return new Promise<void>((resolve, reject) => {
      const onConnect = (method: 'PUT' | 'SOURCE' = 'PUT') => {
        const auth = Buffer.from(`${username}:${password}`).toString('base64');
        const contentType = CONTENT_TYPES[config.format] || 'audio/mpeg';

        const headers = method === 'PUT'
          ? [
              `PUT ${mount} HTTP/1.1`,
              `Host: ${host}:${port}`,
              `Authorization: Basic ${auth}`,
              `User-Agent: WebIce/1.0`,
              `Content-Type: ${contentType}`,
              `Ice-Public: 0`,
              `Ice-Name: ${config.streamName}`,
              `Expect: 100-continue`,
              '', '',
            ].join('\r\n')
          : [
              `SOURCE ${mount} HTTP/1.0`,
              `Authorization: Basic ${auth}`,
              `User-Agent: WebIce/1.0`,
              `Content-Type: ${contentType}`,
              `Ice-Public: 0`,
              `Ice-Name: ${config.streamName}`,
              '', '',
            ].join('\r\n');

        this.socket!.write(headers);

        let buffer = '';
        const onData = (data: Buffer) => {
          buffer += data.toString('latin1');
          const headerEnd = buffer.indexOf('\r\n\r\n');
          if (headerEnd < 0) return;
          const response = buffer.slice(0, headerEnd);
          const body = buffer.slice(headerEnd + 4).trim();
          this.socket!.off('data', onData);
          const firstLine = response.split('\r\n')[0] || response;
          const statusMatch = firstLine.match(/^(?:HTTP|ICE)\/\d\.\d\s+(\d+)/);
          const status = statusMatch ? parseInt(statusMatch[1]) : 0;

          if (status === 100 || status === 200) {
            this.connected = true;
            this.reconnectAttempts = 0;
            this.reconnecting = false;
            // Disable the handshake timeout now that we're streaming —
            // Icecast never sends data back to a source client, so an
            // idle-read timeout would spuriously kill a healthy stream.
            try { this.socket!.setTimeout(0); } catch { /* ok */ }
            this.emit('connected');
            resolve();
            return;
          }

          // Fall back to legacy SOURCE method on first auth/method failure
          if (method === 'PUT' && (status === 401 || status === 403 || status === 405 || status === 501 || status === 400)) {
            this.socket?.destroy();
            const fallback = useSSL
              ? tls.connect({ host, port, servername: host, ALPNProtocols: ['http/1.1'], rejectUnauthorized: false }, () => onConnect('SOURCE'))
              : net.connect({ host, port }, () => onConnect('SOURCE'));
            this.socket = fallback;
            fallback.setNoDelay(true);
            fallback.setKeepAlive(true, 30000);
            fallback.setTimeout(10000);
            fallback.on('error', onSocketError);
            fallback.on('close', onSocketClose);
            fallback.on('timeout', onSocketTimeout);
            return;
          }

          const snippet = body ? ` — server said: ${body.slice(0, 200)}` : '';
          let detail: string;
          if (status === 401 || status === 403) {
            detail = `Authentication failed for ${target} (user "${username}")${snippet}`;
          } else if (status === 404) {
            detail = `Mount point "${mount}" not found on ${host}:${port}${snippet}`;
          } else if (status === 409) {
            detail = `Mount "${mount}" is already in use on ${host}:${port}${snippet}`;
          } else if (status === 405 || status === 501) {
            detail = `${host}:${port} rejected both PUT and SOURCE — not a direct Icecast endpoint?${snippet}`;
          } else {
            detail = `Server rejected connection to ${target}: ${firstLine}${snippet}`;
          }
          const err = new Error(detail);
          // During auto-reconnect, suppress the error toast so transient
          // "mount still held" 401/403/409 responses from the server don't
          // spam the UI while we're retrying.
          if (!this.reconnecting) this.emit('error', err);
          reject(err);
          // Destroy the socket so the close handler fires and
          // scheduleReconnect() is triggered. Without this, a handshake
          // rejection would leave the socket half-open and the reconnect
          // loop would stall after one failed attempt.
          this.socket?.destroy();
        };
        this.socket!.on('data', onData);
      };

      const onSocketError = (err: NodeJS.ErrnoException) => {
        let detail: string;
        if (err.code === 'ECONNREFUSED') {
          detail = `Connection refused by ${host}:${port} — is the server running?`;
        } else if (err.code === 'ENOTFOUND') {
          detail = `Could not resolve hostname "${host}" — check the URL`;
        } else if (err.code === 'ETIMEDOUT') {
          detail = `Connection to ${host}:${port} timed out`;
        } else if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
          detail = `Connection to ${host}:${port} was reset`;
        } else if (err.code === 'CERT_HAS_EXPIRED' || err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
          detail = `TLS certificate error for ${host}:${port}: ${err.message}`;
        } else {
          detail = `Network error on ${target}: ${err.message}`;
        }
        const wrapped = new Error(detail);
        // Only emit error on the first failure so we don't spam the UI
        // while reconnect attempts keep failing.
        if (!this.reconnecting) this.emit('error', wrapped);
        reject(wrapped);
        // Close handler will run next and drive the reconnect.
      };

      const onSocketClose = () => {
        const wasConnected = this.connected;
        this.connected = false;
        if (wasConnected) this.emit('disconnected');
        if (!this.intentionalDisconnect) this.scheduleReconnect();
      };

      const onSocketTimeout = () => {
        this.socket?.destroy(new Error(`Connection to ${host}:${port} timed out after 10s`));
      };

      this.socket = useSSL
        ? tls.connect(
            {
              host,
              port,
              servername: host,
              ALPNProtocols: ['http/1.1'],
              rejectUnauthorized: false,
            },
            () => onConnect('PUT')
          )
        : net.connect({ host, port }, () => onConnect('PUT'));

      this.socket.setNoDelay(true);
      // Keep NAT / firewall state alive on the inbound side. Icecast never
      // sends data back to a source client, so home routers and ISP gateways
      // commonly drop the connection state after ~5 minutes of no inbound
      // traffic. TCP keepalive probes from the OS prevent that.
      this.socket.setKeepAlive(true, 30000);
      this.socket.setTimeout(10000);
      this.socket.on('error', onSocketError);
      this.socket.on('close', onSocketClose);
      this.socket.on('timeout', onSocketTimeout);
    });
  }

  send(data: Buffer): boolean {
    if (!this.connected || !this.socket || this.socket.destroyed) return false;
    try {
      return this.socket.write(data);
    } catch {
      return false;
    }
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    this.reconnecting = false;
    this.reconnectAttempts = 0;
    this.config = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.connected = false;
  }

  private scheduleReconnect(): void {
    if (!this.config || this.reconnectTimer || this.intentionalDisconnect) return;
    // Exponential backoff capped at 30s: 1, 2, 4, 8, 16, 30, 30, ...
    const attempt = this.reconnectAttempts++;
    const delay = Math.min(30000, 1000 * Math.pow(2, attempt));
    this.reconnecting = true;
    this.emit('reconnecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.config && !this.intentionalDisconnect) {
        this.connect(this.config).catch(() => {
          // connect() will have scheduled another reconnect via the close handler.
        });
      }
    }, delay);
  }

  get isConnected(): boolean {
    return this.connected;
  }
}
