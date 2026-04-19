// @vitest-environment node
import { describe, it, expect, vi } from 'vitest';
import { pollListeners, resolvePollUrl, type FetchJson } from './listener-poll';

/** Build a fetch mock whose behaviour is driven by a url → response map.
 *  Responses can be: a plain object (resolved), or an Error (rejected). */
function makeFetch(responses: Record<string, unknown | Error>): FetchJson {
  return vi.fn(async (url: string) => {
    if (!(url in responses)) throw new Error(`unexpected URL in test: ${url}`);
    const v = responses[url];
    if (v instanceof Error) throw v;
    return v;
  });
}

describe('pollListeners — endpoint fallback order', () => {
  const serverUrl = 'http://example.com:8000/suno.mp3';
  const origin = 'http://example.com:8000';
  const mount = '/suno.mp3';

  it('prefers the RSAS per-mount health endpoint when it returns a count', async () => {
    const fetchJson = makeFetch({
      [`${origin}${mount}/health`]: { listener_count: 7 },
    });
    const result = await pollListeners(serverUrl, fetchJson);
    expect(result).toEqual({ count: 7 });
    // Only the first endpoint should have been consulted.
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });

  it('falls through to RSAS server /health when per-mount fails', async () => {
    const fetchJson = makeFetch({
      [`${origin}${mount}/health`]: new Error('404'),
      [`${origin}/health`]: {
        mounts: {
          '/suno.mp3': { listener_count: 12 },
          '/beats.mp3': { listener_count: 3 },
        },
      },
    });
    const result = await pollListeners(serverUrl, fetchJson);
    expect(result).toEqual({ count: 12 });
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });

  it('falls through to Icecast /status-json.xsl as last resort', async () => {
    const fetchJson = makeFetch({
      [`${origin}${mount}/health`]: new Error('404'),
      [`${origin}/health`]: new Error('404'),
      [`${origin}/status-json.xsl`]: {
        icestats: {
          source: [
            { mount: '/beats.mp3', listeners: 3 },
            { mount: '/suno.mp3', listeners: 42 },
          ],
        },
      },
    });
    const result = await pollListeners(serverUrl, fetchJson);
    expect(result).toEqual({ count: 42 });
    expect(fetchJson).toHaveBeenCalledTimes(3);
  });

  it('matches Icecast sources by listenurl suffix when mount field is absent', async () => {
    const fetchJson = makeFetch({
      [`${origin}${mount}/health`]: new Error('404'),
      [`${origin}/health`]: new Error('404'),
      [`${origin}/status-json.xsl`]: {
        icestats: {
          source: [
            { listenurl: 'http://example.com/suno.mp3', listeners: 5 },
          ],
        },
      },
    });
    const result = await pollListeners(serverUrl, fetchJson);
    expect(result.count).toBe(5);
  });

  it('handles Icecast single-source (non-array) payloads', async () => {
    const fetchJson = makeFetch({
      [`${origin}${mount}/health`]: new Error('404'),
      [`${origin}/health`]: new Error('404'),
      [`${origin}/status-json.xsl`]: {
        icestats: {
          source: { mount: '/suno.mp3', listeners: 9 },
        },
      },
    });
    const result = await pollListeners(serverUrl, fetchJson);
    expect(result.count).toBe(9);
  });

  it('returns an error PollResult when every endpoint fails', async () => {
    const fetchJson = makeFetch({
      [`${origin}${mount}/health`]: new Error('connection refused'),
      [`${origin}/health`]: new Error('timeout'),
      [`${origin}/status-json.xsl`]: new Error('not found'),
    });
    const result = await pollListeners(serverUrl, fetchJson);
    expect(result.count).toBe(-1);
    expect(result.error).toBeTruthy();
    expect(result.error).toContain('/suno.mp3');
    expect(result.error).toContain('not found');
  });

  it('returns an error PollResult for invalid server URLs', async () => {
    const fetchJson = vi.fn();
    const result = await pollListeners('not a url', fetchJson as FetchJson);
    expect(result.count).toBe(-1);
    expect(result.error).toContain('Invalid server URL');
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it('treats a non-numeric listener_count as a miss, not a zero', async () => {
    const fetchJson = makeFetch({
      [`${origin}${mount}/health`]: { listener_count: 'oops' },
      [`${origin}/health`]: { mounts: { '/suno.mp3': { listener_count: 4 } } },
    });
    const result = await pollListeners(serverUrl, fetchJson);
    expect(result.count).toBe(4);
  });

  it('returns the mount-specific count even when other mounts have more listeners', async () => {
    const fetchJson = makeFetch({
      [`${origin}${mount}/health`]: new Error('404'),
      [`${origin}/health`]: {
        mounts: {
          '/beats.mp3': { listener_count: 1000 },
          '/suno.mp3': { listener_count: 1 },
        },
      },
    });
    const result = await pollListeners(serverUrl, fetchJson);
    expect(result.count).toBe(1);
  });

  it('does not call the second or third endpoint when the first succeeds with 0', async () => {
    const fetchJson = makeFetch({
      [`${origin}${mount}/health`]: { listener_count: 0 },
    });
    const result = await pollListeners(serverUrl, fetchJson);
    expect(result).toEqual({ count: 0 });
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });
});

describe('resolvePollUrl — override vs stream URL', () => {
  const streamUrl = 'http://oriolgomez.com:8000/live.mp3';
  const override = 'http://oriolgomez.com:8000/stream.mp3';

  it('falls back to the stream URL when no override is given', () => {
    expect(resolvePollUrl(streamUrl)).toBe(streamUrl);
  });

  it('falls back to the stream URL when override is undefined', () => {
    expect(resolvePollUrl(streamUrl, undefined)).toBe(streamUrl);
  });

  it('falls back to the stream URL when override is null', () => {
    expect(resolvePollUrl(streamUrl, null)).toBe(streamUrl);
  });

  it('falls back to the stream URL when override is an empty string', () => {
    expect(resolvePollUrl(streamUrl, '')).toBe(streamUrl);
  });

  it('falls back to the stream URL when override is whitespace only', () => {
    expect(resolvePollUrl(streamUrl, '   ')).toBe(streamUrl);
    expect(resolvePollUrl(streamUrl, '\t\n')).toBe(streamUrl);
  });

  it('uses the override when it has content', () => {
    expect(resolvePollUrl(streamUrl, override)).toBe(override);
  });

  it('trims surrounding whitespace from the override', () => {
    expect(resolvePollUrl(streamUrl, `  ${override}  `)).toBe(override);
  });

  it('uses the override even when the stream URL is empty', () => {
    // Defensive: if somehow the stream URL isn't set yet but the override is,
    // prefer the override rather than polling an empty string.
    expect(resolvePollUrl('', override)).toBe(override);
  });

  it('never mutates its inputs', () => {
    const s = streamUrl;
    const o = `  ${override}  `;
    resolvePollUrl(s, o);
    expect(s).toBe(streamUrl);
    expect(o).toBe(`  ${override}  `);
  });
});

describe('resolvePollUrl + pollListeners integration', () => {
  it('when user sets listenerCountUrl, pollListeners hits the override mount, not the source mount', async () => {
    const streamUrl = 'http://oriolgomez.com:8000/live.mp3';
    const override = 'http://oriolgomez.com:8000/stream.mp3';
    const fetchJson = vi.fn(async (url: string) => {
      // Only the override mount returns a real count. The source mount's
      // count would be wrong (relay-source listeners, not audience).
      if (url === 'http://oriolgomez.com:8000/stream.mp3/health') {
        return { listener_count: 42 };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const chosen = resolvePollUrl(streamUrl, override);
    const result = await pollListeners(chosen, fetchJson);
    expect(result.count).toBe(42);
    // Sanity: the /live.mp3 mount was never probed.
    expect(fetchJson).not.toHaveBeenCalledWith(expect.stringContaining('/live.mp3'));
  });

  it('when user leaves listenerCountUrl blank, pollListeners hits the source mount', async () => {
    const streamUrl = 'http://oriolgomez.com:8000/live.mp3';
    const fetchJson = vi.fn(async (url: string) => {
      if (url === 'http://oriolgomez.com:8000/live.mp3/health') {
        return { listener_count: 7 };
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const chosen = resolvePollUrl(streamUrl, '');
    const result = await pollListeners(chosen, fetchJson);
    expect(result.count).toBe(7);
    expect(fetchJson).toHaveBeenCalledWith('http://oriolgomez.com:8000/live.mp3/health');
  });
});

describe('pollListeners — edge cases', () => {
  it('handles a URL whose path is just "/" (root mount) without crashing', async () => {
    const fetchJson = makeFetch({
      'http://example.com:8000//health': new Error('nope'),
      'http://example.com:8000/health': { mounts: { '/': { listener_count: 2 } } },
    });
    const result = await pollListeners('http://example.com:8000/', fetchJson);
    expect(result.count).toBe(2);
  });

  it('surfaces the most recent failure message in the combined error', async () => {
    const fetchJson = makeFetch({
      'http://h:1/m/health': new Error('per-mount boom'),
      'http://h:1/health': new Error('server boom'),
      'http://h:1/status-json.xsl': new Error('icecast boom'),
    });
    const result = await pollListeners('http://h:1/m', fetchJson);
    expect(result.error).toContain('icecast boom');
  });
});
