export interface MicEffects {
  boost: boolean;
  noiseGate: boolean;
  compressor: boolean;
  presence: boolean;
  megaphone: boolean;
  reverb: boolean;
}

export interface CompressorParams {
  threshold: number;
  ratio: number;
  attack: number;
  release: number;
  knee: number;
  makeupGain: number;
}

export interface NoiseGateParams {
  threshold: number;
  attack: number;
  release: number;
  hold: number;
}

export interface EncoderConfig {
  format: string;
  bitrate: number;
  sampleRate: number;
  channels: number;
}

export interface IcecastConfig {
  url: string;
  username: string;
  password: string;
  format: string;
  streamName: string;
}

export interface HlsConfig {
  path: string;
  format: string;
  bitrate: number;
  sampleRate: number;
  channels: number;
}

export interface ServerProfile {
  id: string;
  name: string;
  url: string;
  username: string;
  password: string;
  streamName: string;
}

export type StreamFormat = 'mp3' | 'ogg' | 'aac' | 'opus' | 'flac';

export const FORMAT_EXTENSIONS: Record<StreamFormat, string> = {
  mp3: '.mp3',
  ogg: '.ogg',
  aac: '.aac',
  opus: '.opus',
  flac: '.flac',
};

export const FORMAT_LABELS: Record<StreamFormat, string> = {
  mp3: 'MP3',
  ogg: 'OGG Vorbis',
  aac: 'AAC',
  opus: 'Opus',
  flac: 'FLAC',
};

export const BITRATE_OPTIONS = [64, 96, 128, 160, 192, 224, 256, 320] as const;
