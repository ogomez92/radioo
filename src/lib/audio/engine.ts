import type { MicEffects } from '../types';

export class AudioEngine {
  private ctx!: AudioContext;

  // Sources
  private micSource: MediaStreamAudioSourceNode | null = null;
  private micStream: MediaStream | null = null;
  // Per-process system audio: one AudioWorkletNode per captured PID, all summed
  // into sysInputGain by Web Audio's implicit mixing.
  private sysPcmNodes = new Map<number, AudioWorkletNode>();

  // Gain control
  private micInputGain!: GainNode;
  private sysInputGain!: GainNode;
  private sysDuckGain!: GainNode;
  private musicGain!: GainNode;
  private musicDuckGain!: GainNode;
  private masterGain!: GainNode;

  // Music player
  private musicBuffer: AudioBuffer | null = null;
  private musicSource: AudioBufferSourceNode | null = null;
  private musicStartedAt = 0;
  private musicOffset = 0;
  private musicPlayingState = false;
  private musicStoppingForPause = false;
  private onMusicEnded: (() => void) | null = null;

  // Effects nodes
  private fxBoost!: GainNode;
  private fxNoiseGate!: AudioWorkletNode;
  private fxCompressor!: DynamicsCompressorNode;
  private fxPresence1!: BiquadFilterNode;
  private fxPresence2!: BiquadFilterNode;
  private fxMegaphoneHP!: BiquadFilterNode;
  private fxMegaphoneLP!: BiquadFilterNode;
  private fxReverbConvolver!: ConvolverNode;
  private fxReverbDry!: GainNode;
  private fxReverbWet!: GainNode;
  private fxLimiter!: DynamicsCompressorNode;
  private fxOutput!: GainNode;

  // Analysis
  private micAnalyser!: AnalyserNode;
  private masterAnalyser!: AnalyserNode;

  // PCM capture
  private pcmCapture!: AudioWorkletNode;

  // State
  private effects: MicEffects = {
    boost: false,
    noiseGate: false,
    compressor: true,
    presence: true,
    megaphone: false,
    reverb: false,
  };
  private duckingEnabled = false;
  private duckAmount = 0.5;
  private duckRafId = 0;
  private micMuted = false;
  private micGainValue = 1.0;
  private sysGainValue = 1.0;
  private onPcmData: ((buffer: Float32Array) => void) | null = null;

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  get audioContext(): AudioContext | null {
    return this.ctx ?? null;
  }

  async init(onPcmData: (buffer: Float32Array) => void): Promise<void> {
    this.onPcmData = onPcmData;
    this.ctx = new AudioContext({ sampleRate: 48000 });

    await this.ctx.audioWorklet.addModule(new URL('worklets/noise-gate-processor.js', document.baseURI).href);
    await this.ctx.audioWorklet.addModule(new URL('worklets/pcm-capture-processor.js', document.baseURI).href);
    await this.ctx.audioWorklet.addModule(new URL('worklets/sys-pcm-player-processor.js', document.baseURI).href);

    this.createNodes();
    this.connectPermanentRouting();
    this.rebuildEffectsChain();
    this.startDuckingDetection();
  }

  private createNodes(): void {
    const c = this.ctx;

    // Input/output gains
    this.micInputGain = c.createGain();
    this.sysInputGain = c.createGain();
    this.sysDuckGain = c.createGain();
    this.musicGain = c.createGain();
    this.musicGain.gain.value = 1.0;
    this.musicDuckGain = c.createGain();
    this.masterGain = c.createGain();
    this.fxOutput = c.createGain();

    // Effects: boost (+6 dB)
    this.fxBoost = c.createGain();
    this.fxBoost.gain.value = 2.0;

    // Effects: noise gate (AudioWorklet)
    this.fxNoiseGate = new AudioWorkletNode(c, 'noise-gate-processor');

    // Effects: compressor
    this.fxCompressor = c.createDynamicsCompressor();
    this.fxCompressor.threshold.value = -25;
    this.fxCompressor.ratio.value = 3;
    this.fxCompressor.attack.value = 0.02;
    this.fxCompressor.release.value = 0.2;
    this.fxCompressor.knee.value = 5;

    // Effects: presence EQ (two peaking bands)
    this.fxPresence1 = c.createBiquadFilter();
    this.fxPresence1.type = 'peaking';
    this.fxPresence1.frequency.value = 2500;
    this.fxPresence1.Q.value = 1.5;
    this.fxPresence1.gain.value = 3;

    this.fxPresence2 = c.createBiquadFilter();
    this.fxPresence2.type = 'peaking';
    this.fxPresence2.frequency.value = 4000;
    this.fxPresence2.Q.value = 1.5;
    this.fxPresence2.gain.value = 3;

    // Effects: megaphone (bandpass via HP+LP)
    this.fxMegaphoneHP = c.createBiquadFilter();
    this.fxMegaphoneHP.type = 'highpass';
    this.fxMegaphoneHP.frequency.value = 400;

    this.fxMegaphoneLP = c.createBiquadFilter();
    this.fxMegaphoneLP.type = 'lowpass';
    this.fxMegaphoneLP.frequency.value = 3500;

    // Effects: reverb (convolution)
    this.fxReverbConvolver = c.createConvolver();
    this.fxReverbConvolver.buffer = this.generateImpulseResponse(1.8, 2.5);
    this.fxReverbDry = c.createGain();
    this.fxReverbDry.gain.value = 0.83;
    this.fxReverbWet = c.createGain();
    this.fxReverbWet.gain.value = 0.17;

    // Effects: limiter
    this.fxLimiter = c.createDynamicsCompressor();
    this.fxLimiter.threshold.value = -1;
    this.fxLimiter.ratio.value = 20;
    this.fxLimiter.attack.value = 0.003;
    this.fxLimiter.release.value = 0.05;
    this.fxLimiter.knee.value = 0;

    // Analysers
    this.micAnalyser = c.createAnalyser();
    this.micAnalyser.fftSize = 256;
    this.micAnalyser.smoothingTimeConstant = 0.8;

    this.masterAnalyser = c.createAnalyser();
    this.masterAnalyser.fftSize = 2048;
    this.masterAnalyser.smoothingTimeConstant = 0.8;

    // PCM capture worklet
    this.pcmCapture = new AudioWorkletNode(c, 'pcm-capture-processor');
    this.pcmCapture.port.onmessage = (e: MessageEvent) => {
      if (e.data.type === 'pcm' && this.onPcmData) {
        this.onPcmData(e.data.buffer);
      }
    };
  }

  private connectPermanentRouting(): void {
    // System audio (per-process capture): sysInputGain → sysDuckGain → masterGain.
    // sysDuckGain shares the same detector as musicDuckGain, so game/app audio
    // drops when the mic picks up speech.
    this.sysInputGain.connect(this.sysDuckGain);
    this.sysDuckGain.connect(this.masterGain);

    // Music player: musicGain → musicDuckGain → masterGain (effects-free, ducked)
    this.musicGain.connect(this.musicDuckGain);
    this.musicDuckGain.connect(this.masterGain);

    // Mic analysed for ducking detection
    this.micInputGain.connect(this.micAnalyser);

    // Effects output merges into master
    this.fxOutput.connect(this.masterGain);

    // Master: masterGain → masterAnalyser → pcmCapture
    this.masterGain.connect(this.masterAnalyser);
    this.masterAnalyser.connect(this.pcmCapture);
  }

  rebuildEffectsChain(): void {
    // Disconnect mic from effects (keep micAnalyser connection)
    try { this.micInputGain.disconnect(this.fxOutput); } catch { /* not connected */ }
    try { this.micInputGain.disconnect(this.fxBoost); } catch { /* ok */ }
    try { this.micInputGain.disconnect(this.fxNoiseGate); } catch { /* ok */ }
    try { this.micInputGain.disconnect(this.fxCompressor); } catch { /* ok */ }
    try { this.micInputGain.disconnect(this.fxPresence1); } catch { /* ok */ }
    try { this.micInputGain.disconnect(this.fxMegaphoneHP); } catch { /* ok */ }
    try { this.micInputGain.disconnect(this.fxLimiter); } catch { /* ok */ }

    // Disconnect all effect nodes from their outputs
    for (const node of [
      this.fxBoost, this.fxNoiseGate, this.fxCompressor,
      this.fxPresence1, this.fxPresence2,
      this.fxMegaphoneHP, this.fxMegaphoneLP,
      this.fxReverbConvolver, this.fxReverbDry, this.fxReverbWet,
      this.fxLimiter,
    ]) {
      try { node.disconnect(); } catch { /* ok */ }
    }

    // Build ordered chain of enabled effects
    const chain: AudioNode[] = [];
    if (this.effects.boost) chain.push(this.fxBoost);
    if (this.effects.noiseGate) chain.push(this.fxNoiseGate);
    if (this.effects.compressor) chain.push(this.fxCompressor);
    if (this.effects.presence) {
      chain.push(this.fxPresence1);
      chain.push(this.fxPresence2);
    }
    if (this.effects.megaphone) {
      chain.push(this.fxMegaphoneHP);
      chain.push(this.fxMegaphoneLP);
    }

    const hasAnyEffect = chain.length > 0 || this.effects.reverb;

    if (!hasAnyEffect) {
      // No effects: mic → fxOutput directly
      this.micInputGain.connect(this.fxOutput);
      return;
    }

    // Connect the chain
    let lastNode: AudioNode = this.micInputGain;
    for (const node of chain) {
      lastNode.connect(node);
      lastNode = node;
    }

    if (this.effects.reverb) {
      // Parallel dry/wet reverb path before limiter
      lastNode.connect(this.fxReverbDry);
      lastNode.connect(this.fxReverbConvolver);
      this.fxReverbConvolver.connect(this.fxReverbWet);
      this.fxReverbDry.connect(this.fxLimiter);
      this.fxReverbWet.connect(this.fxLimiter);
    } else {
      lastNode.connect(this.fxLimiter);
    }

    this.fxLimiter.connect(this.fxOutput);
  }

  // --- Device management ---

  async setMicDevice(deviceId: string): Promise<void> {
    if (this.micStream) {
      this.micStream.getTracks().forEach((t) => t.stop());
      this.micSource?.disconnect();
      this.micSource = null;
      this.micStream = null;
    }

    if (!deviceId) return;

    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: deviceId },
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });

    await this.ctx.resume();
    this.micSource = this.ctx.createMediaStreamSource(this.micStream);
    this.micSource.connect(this.micInputGain);
  }

  /** Registers a per-process PCM source. The worklet node is created on first use. */
  attachSysSource(pid: number): void {
    if (this.sysPcmNodes.has(pid)) return;
    const node = new AudioWorkletNode(this.ctx, 'sys-pcm-player-processor', {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.port.onmessage = (e: MessageEvent) => {
      if (e.data?.type === 'playing') {
        console.log('[audio] sys worklet pid=%d started playing', pid);
      }
    };
    node.connect(this.sysInputGain);
    this.sysPcmNodes.set(pid, node);
    console.log('[audio] attachSysSource pid=%d (total=%d)', pid, this.sysPcmNodes.size);
    // Resume ctx if it was suspended — same behaviour as getUserMedia path.
    this.ctx.resume().catch(() => { /* ignore */ });
  }

  detachSysSource(pid: number): void {
    const node = this.sysPcmNodes.get(pid);
    if (!node) return;
    try { node.disconnect(); } catch { /* ok */ }
    node.port.postMessage({ type: 'flush' });
    this.sysPcmNodes.delete(pid);
  }

  detachAllSysSources(): void {
    for (const pid of [...this.sysPcmNodes.keys()]) this.detachSysSource(pid);
  }

  /** Posts a PCM chunk to the worklet for the given PID. Auto-attaches if unknown. */
  pushSysPcm(pid: number, interleaved: ArrayBuffer): void {
    let node = this.sysPcmNodes.get(pid);
    if (!node) {
      this.attachSysSource(pid);
      node = this.sysPcmNodes.get(pid)!;
    }
    node.port.postMessage({ type: 'pcm', buffer: interleaved }, [interleaved]);
  }

  get activeSysPids(): number[] {
    return [...this.sysPcmNodes.keys()];
  }

  // --- Controls ---

  setMicGain(value: number): void {
    this.micGainValue = value;
    if (!this.micMuted) {
      this.micInputGain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.01);
    }
  }

  setSysGain(value: number): void {
    this.sysGainValue = value;
    this.sysInputGain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.01);
  }

  setMasterGain(value: number): void {
    this.masterGain.gain.setTargetAtTime(value, this.ctx.currentTime, 0.01);
  }

  setMicMuted(muted: boolean): void {
    this.micMuted = muted;
    const target = muted ? 0 : this.micGainValue;
    this.micInputGain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.005);
  }

  setEffects(effects: MicEffects): void {
    this.effects = { ...effects };
    this.rebuildEffectsChain();
  }

  async loadImpulseResponse(arrayBuffer: ArrayBuffer): Promise<void> {
    const audioBuffer = await this.ctx.decodeAudioData(arrayBuffer);
    this.fxReverbConvolver.buffer = audioBuffer;
    if (this.effects.reverb) {
      this.rebuildEffectsChain();
    }
  }

  resetImpulseResponse(): void {
    this.fxReverbConvolver.buffer = this.generateImpulseResponse(1.8, 2.5);
    if (this.effects.reverb) {
      this.rebuildEffectsChain();
    }
  }

  setDucking(enabled: boolean, amount: number): void {
    this.duckingEnabled = enabled;
    this.duckAmount = Math.max(0, Math.min(1, amount));
    if (!enabled) {
      const now = this.ctx.currentTime;
      this.musicDuckGain.gain.setTargetAtTime(1, now, 0.05);
      this.sysDuckGain.gain.setTargetAtTime(1, now, 0.05);
    }
  }

  momentaryDuck(active: boolean): void {
    const now = this.ctx.currentTime;
    if (active) {
      const target = 1 - this.duckAmount;
      this.musicDuckGain.gain.setTargetAtTime(target, now, 0.02);
      this.sysDuckGain.gain.setTargetAtTime(target, now, 0.02);
    } else {
      this.musicDuckGain.gain.setTargetAtTime(1, now, 0.1);
      this.sysDuckGain.gain.setTargetAtTime(1, now, 0.1);
    }
  }

  setCaptureActive(active: boolean): void {
    this.pcmCapture.port.postMessage({ type: 'set-active', active });
  }

  // --- Metering ---

  getMicLevel(): number {
    const buf = new Float32Array(this.micAnalyser.fftSize);
    this.micAnalyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    return Math.sqrt(sum / buf.length);
  }

  getMasterLevel(): [number, number] {
    const buf = new Float32Array(this.masterAnalyser.fftSize);
    this.masterAnalyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const abs = Math.abs(buf[i]);
      if (abs > peak) peak = abs;
    }
    return [peak, peak];
  }

  // --- Voice-activated ducking ---

  private startDuckingDetection(): void {
    const buf = new Float32Array(this.micAnalyser.fftSize);
    let speakingHoldUntil = 0;
    let currentState: 'open' | 'ducked' = 'open';

    const detect = (): void => {
      this.duckRafId = requestAnimationFrame(detect);
      if (!this.duckingEnabled) return;

      const now = this.ctx.currentTime;
      const micActive = !!this.micSource && !this.micMuted;

      if (micActive) {
        this.micAnalyser.getFloatTimeDomainData(buf);
        let sum = 0;
        let peak = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = buf[i];
          sum += v * v;
          const abs = v < 0 ? -v : v;
          if (abs > peak) peak = abs;
        }
        const rms = Math.sqrt(sum / buf.length);
        if (rms > 0.005 || peak > 0.03) {
          speakingHoldUntil = now + 0.35;
        }
      }

      // When mic is muted or missing, treat as silence so any held
      // duck state releases instead of getting stuck closed.
      const nextState: 'open' | 'ducked' = micActive && now < speakingHoldUntil ? 'ducked' : 'open';

      if (nextState !== currentState) {
        currentState = nextState;
        const target = nextState === 'ducked' ? 1 - this.duckAmount : 1;
        const rampTime = nextState === 'ducked' ? now + 0.03 : now + 0.15;
        for (const param of [this.musicDuckGain.gain, this.sysDuckGain.gain]) {
          param.cancelScheduledValues(now);
          param.setValueAtTime(param.value, now);
          param.linearRampToValueAtTime(target, rampTime);
        }
      }
    };

    detect();
  }

  // --- Music player ---

  setMusicEndedCallback(cb: (() => void) | null): void {
    this.onMusicEnded = cb;
  }

  async loadMusicFile(arrayBuffer: ArrayBuffer): Promise<number> {
    this.stopMusicInternal();
    this.musicOffset = 0;
    this.musicPlayingState = false;
    const buf = await this.ctx.decodeAudioData(arrayBuffer.slice(0));
    this.musicBuffer = buf;
    return buf.duration;
  }

  playMusic(): void {
    if (!this.musicBuffer || this.musicPlayingState) return;
    if (this.musicOffset >= this.musicBuffer.duration) this.musicOffset = 0;

    const src = this.ctx.createBufferSource();
    src.buffer = this.musicBuffer;
    src.connect(this.musicGain);
    src.onended = () => {
      if (this.musicStoppingForPause) {
        this.musicStoppingForPause = false;
        return;
      }
      // Natural end
      this.musicSource = null;
      this.musicPlayingState = false;
      this.musicOffset = 0;
      this.onMusicEnded?.();
    };

    this.ctx.resume();
    src.start(0, this.musicOffset);
    this.musicSource = src;
    this.musicStartedAt = this.ctx.currentTime - this.musicOffset;
    this.musicPlayingState = true;
  }

  pauseMusic(): void {
    if (!this.musicPlayingState || !this.musicSource) return;
    const elapsed = this.ctx.currentTime - this.musicStartedAt;
    this.musicOffset = Math.max(0, elapsed);
    this.stopMusicInternal();
    this.musicPlayingState = false;
  }

  private stopMusicInternal(): void {
    if (this.musicSource) {
      try {
        this.musicStoppingForPause = true;
        this.musicSource.stop();
      } catch { /* already stopped */ }
      try { this.musicSource.disconnect(); } catch { /* ok */ }
      this.musicSource = null;
    }
  }

  setMusicVolume(value: number): void {
    const v = Math.max(0, Math.min(1, value));
    this.musicGain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.01);
  }

  get musicIsPlaying(): boolean {
    return this.musicPlayingState;
  }

  get musicHasFile(): boolean {
    return this.musicBuffer !== null;
  }

  getMusicPosition(): number {
    if (!this.musicBuffer) return 0;
    if (this.musicPlayingState) {
      const pos = this.ctx.currentTime - this.musicStartedAt;
      return Math.max(0, Math.min(this.musicBuffer.duration, pos));
    }
    return this.musicOffset;
  }

  getMusicDuration(): number {
    return this.musicBuffer?.duration ?? 0;
  }

  /** Plays a short local beep on the broadcaster's speakers only.
   *  Routed to ctx.destination, so it is NOT mixed into the stream. */
  playWarningBeep(): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const makeBeep = (start: number) => {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 1000;
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(1.0, start + 0.01);
      g.gain.linearRampToValueAtTime(0, start + 0.08);
      osc.connect(g);
      g.connect(this.ctx.destination);
      osc.start(start);
      osc.stop(start + 0.1);
    };
    makeBeep(now);
    makeBeep(now + 0.14);
  }

  /** Two-tone ascending chirp (listener joined). Not mixed into the stream. */
  playListenerUpBeep(): void {
    this.playTwoToneBeep(520, 780);
  }

  /** Two-tone descending chirp (listener left). Not mixed into the stream. */
  playListenerDownBeep(): void {
    this.playTwoToneBeep(780, 520);
  }

  private playTwoToneBeep(freqA: number, freqB: number): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.35, now + 0.01);
    g.gain.setValueAtTime(0.35, now + 0.14);
    g.gain.linearRampToValueAtTime(0, now + 0.18);
    g.connect(this.ctx.destination);

    const osc = this.ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freqA, now);
    osc.frequency.setValueAtTime(freqB, now + 0.08);
    osc.connect(g);
    osc.start(now);
    osc.stop(now + 0.2);
  }

  /** Plays a continuous 1-second beep on the broadcaster's speakers only.
   *  Routed to ctx.destination, so it is NOT mixed into the stream. */
  playDisconnectBeep(): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = 800;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(0.6, now + 0.01);
    g.gain.setValueAtTime(0.6, now + 0.98);
    g.gain.linearRampToValueAtTime(0, now + 1.0);
    osc.connect(g);
    g.connect(this.ctx.destination);
    osc.start(now);
    osc.stop(now + 1.02);
  }

  // --- Utilities ---

  private generateImpulseResponse(duration: number, decay: number): AudioBuffer {
    const length = Math.floor(this.ctx.sampleRate * duration);
    const buffer = this.ctx.createBuffer(2, length, this.ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const data = buffer.getChannelData(ch);
      for (let i = 0; i < length; i++) {
        data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, decay);
      }
    }
    return buffer;
  }

  async resume(): Promise<void> {
    await this.ctx.resume();
  }

  destroy(): void {
    cancelAnimationFrame(this.duckRafId);
    this.setCaptureActive(false);
    this.stopMusicInternal();
    this.detachAllSysSources();
    this.micStream?.getTracks().forEach((t) => t.stop());
    this.ctx.close();
  }
}
