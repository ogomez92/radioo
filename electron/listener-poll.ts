/** Listener-count polling with transparent fallback across three endpoints:
 *   1. RSAS per-mount   GET <origin><mount>/health  → listener_count
 *   2. RSAS server-wide GET <origin>/health         → mounts[<mount>].listener_count
 *   3. Icecast-compat   GET <origin>/status-json.xsl → icestats.source[].listeners
 * The first non-negative integer wins.
 */

import * as https from 'https';
import * as http from 'http';

export type PollResult = { count: number; error?: string };
export type FetchJson = (url: string) => Promise<unknown>;

/** Picks which URL to poll for listener count. When the broadcaster's mount
 *  is relayed (e.g., we SOURCE to /live.mp3 but listeners hit /stream.mp3),
 *  the user can configure a `listenerCountUrl` override. Empty / whitespace /
 *  missing overrides fall back to the stream URL itself. */
export function resolvePollUrl(streamUrl: string, override?: string | null): string {
  const trimmed = override?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : streamUrl;
}

export function defaultFetchJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid JSON from server')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

export async function pollListeners(serverUrl: string, fetchJson: FetchJson = defaultFetchJson): Promise<PollResult> {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    return { count: -1, error: `Invalid server URL: ${serverUrl}` };
  }
  const origin = `${parsed.protocol}//${parsed.host}`;
  const mount = parsed.pathname || '/';
  const attempts: Array<() => Promise<number | null>> = [
    () => fetchRsasMountHealth(origin, mount, fetchJson),
    () => fetchRsasServerHealth(origin, mount, fetchJson),
    () => fetchIcecastStatus(origin, mount, fetchJson),
  ];

  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      const n = await attempt();
      if (typeof n === 'number' && n >= 0) return { count: n };
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  const combined = errors.length ? errors[errors.length - 1] : 'no compatible stats endpoint';
  return { count: -1, error: `Listener poll failed for ${mount}: ${combined}` };
}

async function fetchRsasMountHealth(origin: string, mount: string, fetchJson: FetchJson): Promise<number | null> {
  const data = await fetchJson(`${origin}${mount}/health`) as Record<string, unknown>;
  const n = data?.listener_count;
  return typeof n === 'number' ? n : null;
}

async function fetchRsasServerHealth(origin: string, mount: string, fetchJson: FetchJson): Promise<number | null> {
  const data = await fetchJson(`${origin}/health`) as Record<string, unknown>;
  const mounts = data?.mounts as Record<string, { listener_count?: unknown }> | undefined;
  if (!mounts) return null;
  const entry = mounts[mount];
  const n = entry?.listener_count;
  return typeof n === 'number' ? n : null;
}

async function fetchIcecastStatus(origin: string, mount: string, fetchJson: FetchJson): Promise<number | null> {
  const data = await fetchJson(`${origin}/status-json.xsl`) as Record<string, unknown>;
  const icestats = data?.icestats as Record<string, unknown> | undefined;
  if (!icestats) return null;
  const rawSource = icestats.source;
  const sources = Array.isArray(rawSource) ? rawSource : rawSource ? [rawSource] : [];
  const source = sources.find((s: Record<string, unknown>) =>
    s.mount === mount ||
    (typeof s.listenurl === 'string' && s.listenurl.endsWith(mount))
  );
  const n = (source as Record<string, unknown> | undefined)?.listeners;
  return typeof n === 'number' ? n : null;
}
