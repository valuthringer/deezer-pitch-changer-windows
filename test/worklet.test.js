const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SR = 48000;

function loadProcessor() {
  let Processor;
  const context = {
    sampleRate: SR,
    AudioWorkletProcessor: class { constructor() { this.port = {}; } },
    registerProcessor: (name, cls) => { Processor = cls; },
    Math, Number, Float32Array, Float64Array, Int32Array, Uint32Array,
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "src", "inject", "pitch-worklet.js"), "utf8"), context);
  return Processor;
}

const Processor = loadProcessor();

function render(ratio, signal, seconds) {
  const proc = new Processor();
  proc.port.onmessage({ data: { ratio } });
  const total = SR * seconds;
  const out = new Float32Array(total);
  for (let offset = 0; offset < total; offset += 128) {
    const left = new Float32Array(128);
    const right = new Float32Array(128);
    for (let i = 0; i < 128; i++) left[i] = right[i] = signal(offset + i);
    const output = [new Float32Array(128), new Float32Array(128)];
    proc.process([[left, right]], [output]);
    out.set(output[0], offset);
  }
  return out;
}

function power(x, freq, from, to) {
  const w = (2 * Math.PI * freq) / SR;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = from; i < to; i++) {
    const s = x[i] + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}

function dominant(x, low, high) {
  let best = -1;
  let bestFreq = 0;
  for (let f = low; f <= high; f += 0.25) {
    const p = power(x, f, SR, x.length);
    if (p > best) [best, bestFreq] = [p, f];
  }
  return bestFreq;
}

const rms = (x, from, to) => Math.sqrt(x.slice(from, to).reduce((s, v) => s + v * v, 0) / (to - from));

for (const semitones of [-7, -1, 2, 5, 12]) {
  test(`shifts a 440 Hz tone by ${semitones} semitones without changing its level`, () => {
    const ratio = Math.pow(2, semitones / 12);
    const out = render(ratio, (n) => 0.5 * Math.sin((2 * Math.PI * 440 * n) / SR), 2);
    const expected = 440 * ratio;
    assert.ok(Math.abs(dominant(out, expected * 0.95, expected * 1.05) - expected) < 0.5);
    assert.ok(Math.abs(rms(out, SR, 2 * SR) - 0.5 / Math.SQRT2) < 0.05);
  });
}

test("ratio 1 is a pure delay of 4096 samples", () => {
  const signal = (n) => 0.3 * Math.sin(n / 7) + 0.2 * Math.sin(n / 31);
  const out = render(1, signal, 1);
  for (let i = 4096; i < out.length; i += 97) assert.ok(Math.abs(out[i] - signal(i - 4096)) < 1e-6);
});
