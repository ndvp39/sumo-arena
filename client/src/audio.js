// Lightweight synthesized sound effects via the Web Audio API — no sound
// files, no licensing, nothing to load. The game had zero audio before
// this; a handful of short blips/thumps/whooshes for the big moments
// (hits, eliminations, grabs, round wins) does more for how "real" combat
// feels than almost any visual change would, at near-zero cost/risk since
// every call here is purely additive to an existing event handler.
//
// AudioContext requires a user gesture to start in every modern browser —
// initAudio() is called from the PLAY button's click handler in main.js,
// which is exactly that gesture, so playback is never silently blocked.
let ctx = null;

export function initAudio() {
  if (ctx) return;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return; // ancient browser with no Web Audio at all — just no sound, never a crash
  ctx = new AC();
}

// A single tone with an exponential decay envelope (a soft, natural-
// sounding fade rather than an abrupt cutoff, which reads as a "click").
function tone(freq, duration, type = 'sine', volume = 0.3, startDelay = 0) {
  if (!ctx) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.connect(gain).connect(ctx.destination);
  const t0 = ctx.currentTime + startDelay;
  gain.gain.setValueAtTime(volume, t0);
  gain.gain.exponentialRampToValueAtTime(0.001, t0 + duration);
  osc.start(t0);
  osc.stop(t0 + duration + 0.02);
}

// Short burst of white noise, amplitude-tapered across its own length —
// used layered under the tones for shoves/eliminations, since a pure
// oscillator alone reads as an electronic "beep", not a physical impact.
function noiseBurst(duration, volume = 0.3) {
  if (!ctx) return;
  const length = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / length);
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = volume;
  source.connect(gain).connect(ctx.destination);
  source.start();
}

// power: 'normal' | 'charged' | 'special' | 'throw' | 'drop' — pitch drops
// and volume/duration grow with the tier, so a bigger hit sounds bigger
// without needing separate audio assets per tier.
const SHOVE_SOUND = {
  normal:  { freq: 220, duration: 0.12, volume: 0.22 },
  charged: { freq: 150, duration: 0.2,  volume: 0.3 },
  special: { freq: 100, duration: 0.28, volume: 0.35 },
  throw:   { freq: 75,  duration: 0.34, volume: 0.4 },
  drop:    { freq: 260, duration: 0.1,  volume: 0.15 }
};
export function playShove(power = 'normal') {
  const cfg = SHOVE_SOUND[power] || SHOVE_SOUND.normal;
  tone(cfg.freq, cfg.duration, 'square', cfg.volume);
  noiseBurst(cfg.duration * 0.6, cfg.volume * 0.5);
}

export function playEliminate() {
  tone(200, 0.35, 'sawtooth', 0.28);
  tone(90, 0.3, 'sine', 0.2, 0.05);
  noiseBurst(0.25, 0.3);
}

export function playGrab() {
  tone(500, 0.09, 'sine', 0.22);
  tone(720, 0.09, 'sine', 0.2, 0.07);
}

// Fired once on the ready-edge (see main.js), not every progress tick —
// a little "power-up" chime, distinct from the combat sounds above.
export function playSpecialReady() {
  tone(600, 0.1, 'sine', 0.28);
  tone(900, 0.16, 'sine', 0.28, 0.1);
}

export function playRoundWin() {
  tone(523.25, 0.15, 'triangle', 0.28);       // C5
  tone(659.25, 0.15, 'triangle', 0.28, 0.15); // E5
  tone(783.99, 0.35, 'triangle', 0.32, 0.3);  // G5
}
