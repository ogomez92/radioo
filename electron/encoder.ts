import { type ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import { app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

function resolveFfmpegPath(): string {
  const binName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, 'ffmpeg', binName)
    : path.join(app.getAppPath(), 'resources', 'ffmpeg', binName);
  if (fs.existsSync(bundled)) return bundled;
  // Fallback: hope it's on PATH
  return 'ffmpeg';
}

export interface EncoderConfig {
  format: string;
  bitrate: number;
  sampleRate: number;
  channels: number;
}

function buildCodecArgs(format: string, bitrate: number): string[] {
  switch (format) {
    case 'mp3': return ['-codec:a', 'libmp3lame', '-b:a', `${bitrate}k`];
    case 'ogg': return ['-codec:a', 'libvorbis', '-b:a', `${bitrate}k`];
    case 'aac': return ['-codec:a', 'aac', '-b:a', `${bitrate}k`];
    case 'opus': return ['-codec:a', 'libopus', '-b:a', `${bitrate}k`, '-application', 'audio'];
    case 'flac': return ['-codec:a', 'flac'];
    default: return ['-codec:a', 'libmp3lame', '-b:a', `${bitrate}k`];
  }
}

function outputFormat(format: string): string {
  switch (format) {
    case 'ogg': case 'opus': return 'ogg';
    case 'aac': return 'adts';
    case 'flac': return 'flac';
    default: return 'mp3';
  }
}

export class Encoder extends EventEmitter {
  private ffmpeg: ChildProcess | null = null;
  private running = false;

  start(config: EncoderConfig): void {
    if (this.running) return;

    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-f', 'f32le',
      '-ar', String(config.sampleRate),
      '-ac', String(config.channels),
      '-i', 'pipe:0',
      ...buildCodecArgs(config.format, config.bitrate),
      '-f', outputFormat(config.format),
      'pipe:1',
    ];

    this.ffmpeg = spawn(resolveFfmpegPath(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.running = true;

    this.ffmpeg.stdout!.on('data', (data: Buffer) => {
      this.emit('data', data);
    });

    this.ffmpeg.stderr!.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) this.emit('log', line);
    });

    this.ffmpeg.on('close', (code) => {
      this.running = false;
      this.emit('close', code);
    });

    this.ffmpeg.on('error', (err) => {
      this.running = false;
      this.emit('error', err);
    });
  }

  write(pcmData: Buffer): boolean {
    if (!this.running || !this.ffmpeg?.stdin?.writable) return false;
    try {
      return this.ffmpeg.stdin.write(pcmData);
    } catch {
      return false;
    }
  }

  stop(): void {
    if (!this.running || !this.ffmpeg) return;
    this.running = false;
    try { this.ffmpeg.stdin?.end(); } catch { /* ignore */ }
    setTimeout(() => {
      if (this.ffmpeg) {
        this.ffmpeg.kill('SIGTERM');
        this.ffmpeg = null;
      }
    }, 500);
  }

  get isRunning(): boolean {
    return this.running;
  }
}

export class HlsEncoder extends EventEmitter {
  private ffmpeg: ChildProcess | null = null;
  private running = false;

  start(config: EncoderConfig & { hlsPath: string }): void {
    if (this.running) return;

    const args = [
      '-hide_banner', '-loglevel', 'warning',
      '-f', 'f32le',
      '-ar', String(config.sampleRate),
      '-ac', String(config.channels),
      '-i', 'pipe:0',
      ...buildCodecArgs(config.format, config.bitrate),
      '-f', 'hls',
      '-hls_time', '6',
      '-hls_list_size', '10',
      '-hls_flags', 'delete_segments',
      config.hlsPath,
    ];

    this.ffmpeg = spawn(resolveFfmpegPath(), args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.running = true;

    this.ffmpeg.stderr!.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) this.emit('log', line);
    });

    this.ffmpeg.on('close', (code) => {
      this.running = false;
      this.emit('close', code);
    });

    this.ffmpeg.on('error', (err) => {
      this.running = false;
      this.emit('error', err);
    });
  }

  write(pcmData: Buffer): boolean {
    if (!this.running || !this.ffmpeg?.stdin?.writable) return false;
    try {
      return this.ffmpeg.stdin.write(pcmData);
    } catch {
      return false;
    }
  }

  stop(): void {
    if (!this.running || !this.ffmpeg) return;
    this.running = false;
    try { this.ffmpeg.stdin?.end(); } catch { /* ignore */ }
    setTimeout(() => {
      if (this.ffmpeg) {
        this.ffmpeg.kill('SIGTERM');
        this.ffmpeg = null;
      }
    }, 500);
  }

  get isRunning(): boolean {
    return this.running;
  }
}
