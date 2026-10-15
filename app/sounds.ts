// Sunetele interfeței, sintetizate în browser (fără fișiere audio).
// Pornesc doar după o atingere sau un clic, cum cer browserele.

let context: AudioContext | null = null;

function graph() {
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  context = context ?? new Ctor();
  const ctx = context;
  void ctx.resume();
  const t0 = ctx.currentTime + 0.05;
  const compressor = ctx.createDynamicsCompressor();
  compressor.connect(ctx.destination);
  const master = ctx.createGain();
  master.gain.value = 0.55;
  master.connect(compressor);
  // Ecou scurt, pentru spațiu.
  const delay = ctx.createDelay(1);
  delay.delayTime.value = 0.27;
  const feedback = ctx.createGain();
  feedback.gain.value = 0.38;
  const wet = ctx.createGain();
  wet.gain.value = 0.35;
  delay.connect(feedback).connect(delay);
  delay.connect(wet).connect(master);
  const envelope = (gain: GainNode, at: number, peak: number, attack: number, decay: number) => {
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(peak, at + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  };
  const noise = (seconds: number) => {
    const length = Math.floor(ctx.sampleRate * seconds);
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  };
  return { ctx, t0, master, delay, envelope, noise };
}

// Sunetul de pornire în stil JARVIS: pad aerian, ticăituri digitale, ciripituri de sticlă care urcă și un dublu „ding”.
export function bootSound() {
  try {
    const { ctx, t0, master, delay, envelope, noise } = graph();

    const pad = ctx.createBiquadFilter();
    pad.type = "lowpass";
    pad.frequency.setValueAtTime(900, t0);
    pad.frequency.exponentialRampToValueAtTime(4200, t0 + 1.6);
    pad.connect(master);
    pad.connect(delay);
    [164.8, 246.9, 329.6, 493.9, 659.3].forEach((frequency, index) => {
      for (const detune of [-7, 7]) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = index < 2 ? "triangle" : "sine";
        osc.frequency.value = frequency;
        osc.detune.value = detune;
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(0.028, t0 + 1.1);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 3.2);
        osc.connect(gain).connect(pad);
        osc.start(t0);
        osc.stop(t0 + 3.3);
      }
    });

    for (let i = 0; i < 7; i++) {
      const at = t0 + 0.12 + i * 0.06;
      const source = ctx.createBufferSource();
      const highpass = ctx.createBiquadFilter();
      const gain = ctx.createGain();
      source.buffer = noise(0.03);
      highpass.type = "highpass";
      highpass.frequency.value = 5000;
      envelope(gain, at, 0.05, 0.002, 0.02);
      source.connect(highpass).connect(gain).connect(master);
      source.start(at);
    }

    [1318.5, 1568, 1760, 1975.5, 2349.3, 2637, 3136, 3520].forEach((frequency, i) => {
      const at = t0 + 0.45 + i * 0.085;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const pan = ctx.createStereoPanner();
      osc.type = "sine";
      osc.frequency.setValueAtTime(frequency * 0.94, at);
      osc.frequency.exponentialRampToValueAtTime(frequency, at + 0.035);
      envelope(gain, at, 0.04, 0.004, 0.16);
      pan.pan.value = i % 2 ? 0.45 : -0.45;
      osc.connect(gain).connect(pan).connect(master);
      pan.connect(delay);
      osc.start(at);
      osc.stop(at + 0.25);
    });

    for (const [frequency, offset] of [
      [1046.5, 0],
      [1568, 0.11],
    ]) {
      const at = t0 + 1.4 + offset;
      [1, 2.76].forEach((multiple, k) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = frequency * multiple;
        envelope(gain, at, k ? 0.012 : 0.07, 0.004, k ? 0.4 : 1.4);
        osc.connect(gain).connect(master);
        gain.connect(delay);
        osc.start(at);
        osc.stop(at + 1.6);
      });
    }
  } catch {
    // Fără sunet dacă browserul nu permite; interfața merge oricum.
  }
}

// Un mic „ciripit” când apare o fereastră.
export function blipSound() {
  if (!context) return; // doar după ce sunetul a fost pornit printr-o atingere
  try {
    const { ctx, t0, master, delay, envelope } = graph();
    for (const [frequency, offset] of [
      [2093, 0],
      [2637, 0.06],
    ]) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = frequency;
      envelope(gain, t0 + offset, 0.03, 0.003, 0.12);
      osc.connect(gain).connect(master);
      gain.connect(delay);
      osc.start(t0 + offset);
      osc.stop(t0 + offset + 0.2);
    }
  } catch {
    // ignorat
  }
}
