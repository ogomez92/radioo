class NoiseGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'threshold', defaultValue: 0.008, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'attack', defaultValue: 0.015, minValue: 0.001, maxValue: 0.5, automationRate: 'k-rate' },
      { name: 'release', defaultValue: 0.15, minValue: 0.01, maxValue: 2, automationRate: 'k-rate' },
      { name: 'hold', defaultValue: 0.1, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this._envelope = 0;
    this._holdCounter = 0;
  }

  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0]) return true;

    const threshold = parameters.threshold[0];
    const attackCoeff = Math.exp(-1 / (sampleRate * parameters.attack[0]));
    const releaseCoeff = Math.exp(-1 / (sampleRate * parameters.release[0]));
    const holdSamples = Math.floor(sampleRate * parameters.hold[0]);
    const blockSize = input[0].length;

    // Calculate block RMS
    let sum = 0;
    for (let ch = 0; ch < input.length; ch++) {
      for (let i = 0; i < blockSize; i++) {
        sum += input[ch][i] * input[ch][i];
      }
    }
    const rms = Math.sqrt(sum / (input.length * blockSize));
    const gateOpen = rms > threshold;

    if (gateOpen) {
      this._holdCounter = holdSamples;
    }

    for (let i = 0; i < blockSize; i++) {
      const isOpen = gateOpen || this._holdCounter > 0;
      if (!gateOpen && this._holdCounter > 0) {
        this._holdCounter--;
      }

      const target = isOpen ? 1 : 0;
      if (target > this._envelope) {
        this._envelope = attackCoeff * this._envelope + (1 - attackCoeff) * target;
      } else {
        this._envelope = releaseCoeff * this._envelope + (1 - releaseCoeff) * target;
      }

      for (let ch = 0; ch < input.length; ch++) {
        if (output[ch]) {
          output[ch][i] = input[ch][i] * this._envelope;
        }
      }
    }

    return true;
  }
}

registerProcessor('noise-gate-processor', NoiseGateProcessor);
