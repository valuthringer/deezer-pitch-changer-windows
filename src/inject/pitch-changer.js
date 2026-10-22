// Runs in the main world of the Deezer web player (injected by the patched preload).
// `WORKLET_SOURCE` is the source of pitch-worklet.js, passed in by the loader.
function deezerPitchChanger(WORKLET_SOURCE, VERSION) {
  "use strict";

  if (window.__deezerPitchChanger) return;
  if (!/(^|\.)deezer\.com$/.test(location.hostname)) return;

  const LOG_PREFIX = "[deezer-pitch-changer]";
  const STORAGE_KEY = "deezer-pitch-changer:settings";
  const SPEED_MIN = 0.5;
  const SPEED_MAX = 2;
  const SEMITONES_MIN = -12;
  const SEMITONES_MAX = 12;

  const MODES = {
    vinyl: { label: "Speed + pitch" },
    speed: { label: "Speed" },
    pitch: { label: "Pitch" },
  };

  const PRESETS = {
    vinyl: [
      { label: "×0.8", value: 0.8 },
      { label: "×0.9", value: 0.9 },
      { label: "×1.1", value: 1.1 },
      { label: "Nightcore", value: 1.25 },
    ],
    speed: [
      { label: "×0.75", value: 0.75 },
      { label: "×0.9", value: 0.9 },
      { label: "×1.25", value: 1.25 },
      { label: "×1.5", value: 1.5 },
    ],
    pitch: [
      { label: "−2", value: -2 },
      { label: "−1", value: -1 },
      { label: "432 Hz", value: 12 * Math.log2(432 / 440) },
      { label: "+1", value: 1 },
      { label: "+2", value: 2 },
    ],
  };

  const clamp = (v, min, max) => Math.min(max, Math.max(min, v));
  const round = (v, step) => Math.round(v / step) * step;
  const log = (...args) => console.info(LOG_PREFIX, ...args);
  const warn = (...args) => console.warn(LOG_PREFIX, ...args);

  // ---------------------------------------------------------------- settings

  const defaults = {
    enabled: true,
    mode: "vinyl",
    vinyl: 1,
    speed: 1,
    pitch: 0,
    panelOpen: false,
    position: null,
  };

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      const s = Object.assign({}, defaults, saved);
      if (!MODES[s.mode]) s.mode = defaults.mode;
      s.vinyl = clamp(Number(s.vinyl) || 1, SPEED_MIN, SPEED_MAX);
      s.speed = clamp(Number(s.speed) || 1, SPEED_MIN, SPEED_MAX);
      s.pitch = clamp(Number(s.pitch) || 0, SEMITONES_MIN, SEMITONES_MAX);
      return s;
    } catch {
      return Object.assign({}, defaults);
    }
  }

  const settings = loadSettings();

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // Storage unavailable: settings only last for this session.
    }
  }

  // What the current settings mean for the audio pipeline.
  function effect() {
    if (!settings.enabled) return { rate: 1, preservesPitch: true, pitchRatio: 1 };
    switch (settings.mode) {
      case "vinyl":
        return { rate: settings.vinyl, preservesPitch: false, pitchRatio: 1 };
      case "speed":
        return { rate: settings.speed, preservesPitch: true, pitchRatio: 1 };
      default:
        return { rate: 1, preservesPitch: true, pitchRatio: Math.pow(2, settings.pitch / 12) };
    }
  }

  const isNeutral = (fx) => Math.abs(fx.rate - 1) < 1e-4 && Math.abs(fx.pitchRatio - 1) < 1e-4;

  // ---------------------------------------------------------------- media elements

  const known = new WeakSet();
  const tracked = new Set(); // WeakRef<HTMLMediaElement>
  const touched = new WeakSet(); // elements whose rate we changed

  function mediaElements() {
    const list = [];
    for (const ref of tracked) {
      const el = ref.deref();
      if (el) list.push(el);
      else tracked.delete(ref);
    }
    return list;
  }

  function track(el) {
    if (!(el instanceof HTMLMediaElement) || known.has(el)) return;
    known.add(el);
    tracked.add(new WeakRef(el));
    const reapply = () => applyTo(el);
    for (const type of ["loadstart", "loadedmetadata", "play", "playing"]) el.addEventListener(type, reapply);
    el.addEventListener("ratechange", () => {
      const fx = effect();
      if (!isNeutral(fx) && Math.abs(el.playbackRate - fx.rate) > 1e-3) el.playbackRate = fx.rate;
    });
    applyTo(el);
    updateStatus();
  }

  function applyTo(el) {
    const fx = effect();
    if (isNeutral(fx)) {
      // Give control back to Deezer (e.g. its own podcast speed setting).
      if (touched.has(el)) {
        touched.delete(el);
        el.preservesPitch = true;
        el.defaultPlaybackRate = 1;
        el.playbackRate = 1;
      }
    } else {
      touched.add(el);
      if (el.preservesPitch !== fx.preservesPitch) el.preservesPitch = fx.preservesPitch;
      if (el.defaultPlaybackRate !== fx.rate) el.defaultPlaybackRate = fx.rate;
      if (el.playbackRate !== fx.rate) el.playbackRate = fx.rate;
    }
    if (fx.pitchRatio !== 1 && (el.currentSrc || el.srcObject) && !el.paused) {
      routeThroughEngine(el);
    }
    if (engine.node) engine.node.port.postMessage({ ratio: fx.pitchRatio });
  }

  function applyAll() {
    for (const el of mediaElements()) applyTo(el);
    if (engine.node) engine.node.port.postMessage({ ratio: effect().pitchRatio });
  }

  function installHooks() {
    const proto = HTMLMediaElement.prototype;

    for (const name of ["play", "load"]) {
      const original = proto[name];
      proto[name] = function (...args) {
        track(this);
        return original.apply(this, args);
      };
    }

    for (const prop of ["src", "srcObject"]) {
      const desc = Object.getOwnPropertyDescriptor(proto, prop);
      if (!desc || !desc.set) continue;
      Object.defineProperty(proto, prop, {
        configurable: true,
        enumerable: desc.enumerable,
        get: desc.get,
        set(value) {
          track(this);
          desc.set.call(this, value);
        },
      });
    }

    // Elements that start playing without going through the hooks above (autoplay attribute, <source> children).
    const scan = () => document.querySelectorAll("audio, video").forEach(track);
    document.addEventListener("play", (e) => track(e.target), true);
    setInterval(scan, 3000);
  }

  // ---------------------------------------------------------------- audio engine (pitch only)

  const engine = {
    ctx: null,
    node: null,
    loading: null,
    routed: new WeakSet(),
    error: null,
  };

  function startEngine() {
    if (engine.loading) return engine.loading;
    engine.loading = (async () => {
      const ctx = new AudioContext({ latencyHint: "playback" });
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      const node = new AudioWorkletNode(ctx, "deezer-pitch-shift", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        channelCount: 2,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
      });
      node.connect(ctx.destination);
      node.port.postMessage({ ratio: effect().pitchRatio });
      engine.ctx = ctx;
      engine.node = node;
      log(`audio engine ready (${ctx.sampleRate} Hz)`);
      return engine;
    })().catch((err) => {
      engine.error = err;
      engine.loading = null;
      warn("audio engine failed to start", err);
      updateStatus();
      throw err;
    });
    return engine.loading;
  }

  async function routeThroughEngine(el) {
    if (engine.routed.has(el)) {
      if (engine.ctx && engine.ctx.state !== "running") engine.ctx.resume().catch(() => {});
      return;
    }
    engine.routed.add(el);
    let engineReady;
    try {
      engineReady = await startEngine();
    } catch {
      engine.routed.delete(el); // retried on the next play
      updateStatus();
      return;
    }
    try {
      const { ctx, node } = engineReady;
      // Once captured, the element only plays through our graph (for the rest of its life).
      ctx.createMediaElementSource(el).connect(node);
      el.addEventListener("play", () => {
        if (ctx.state !== "running") ctx.resume().catch(() => {});
      });
      if (ctx.state !== "running") await ctx.resume();
      log("player routed through the pitch shifter");
    } catch (err) {
      warn("could not route the player through the pitch shifter", err);
    }
    updateStatus();
  }

  // ---------------------------------------------------------------- formatting

  function formatSemitones(st) {
    const v = Math.abs(st) < 0.005 ? 0 : st;
    const text = Number.isInteger(round(v, 0.01)) ? round(v, 1).toFixed(0) : v.toFixed(2);
    return `${v > 0 ? "+" : v < 0 ? "−" : "±"}${text.replace("-", "")}`;
  }

  function formatRatio(r) {
    return `×${r.toFixed(2)}`;
  }

  function badgeText() {
    if (!settings.enabled) return "Off";
    const fx = effect();
    if (isNeutral(fx)) return "Pitch";
    if (settings.mode === "pitch") return `${formatSemitones(settings.pitch)} st`;
    return formatRatio(settings.mode === "vinyl" ? settings.vinyl : settings.speed);
  }

  // ---------------------------------------------------------------- UI

  const STYLE = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: Inter, "Segoe UI", system-ui, sans-serif; }
    .root {
      --bg: #17171b; --bg2: #232329; --bg3: #2e2e36; --fg: #f2f2f5; --muted: #a0a0ab;
      --accent: #a238ff; --accent2: #c27dff; --border: rgba(255,255,255,.08);
      position: fixed; z-index: 2147483000; color: var(--fg); font-size: 13px;
    }
    .fab {
      display: flex; align-items: center; gap: 6px; height: 36px; padding: 0 14px 0 10px;
      border-radius: 18px; border: 1px solid var(--border); background: var(--bg2); color: var(--fg);
      cursor: pointer; user-select: none; box-shadow: 0 6px 20px rgba(0,0,0,.35); font-weight: 600;
      touch-action: none; white-space: nowrap;
    }
    .fab:hover { background: var(--bg3); }
    .fab.active { border-color: var(--accent); }
    .fab.active svg { color: var(--accent2); }
    .fab svg { width: 18px; height: 18px; flex: none; }
    .fab.off { opacity: .65; }
    .panel {
      position: absolute; bottom: 46px; right: 0; width: 320px; padding: 16px; border-radius: 14px;
      background: var(--bg); border: 1px solid var(--border); box-shadow: 0 16px 48px rgba(0,0,0,.5);
      display: none;
    }
    .root.below .panel { bottom: auto; top: 46px; }
    .root.left .panel { right: auto; left: 0; }
    .panel.open { display: block; }
    .head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
    .title { font-size: 15px; font-weight: 700; }
    .switch { position: relative; width: 38px; height: 22px; border-radius: 11px; background: var(--bg3); border: none; cursor: pointer; padding: 0; }
    .switch::after { content: ""; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: var(--muted); transition: transform .15s, background .15s; }
    .switch.on { background: var(--accent); }
    .switch.on::after { transform: translateX(16px); background: #fff; }
    .modes { display: grid; grid-template-columns: 1.5fr 1fr 1fr; gap: 4px; padding: 4px; border-radius: 10px; background: var(--bg2); margin-bottom: 16px; }
    .modes button { border: none; border-radius: 7px; padding: 7px 4px; background: transparent; color: var(--muted); cursor: pointer; font-size: 12px; font-weight: 600; }
    .modes button.sel { background: var(--bg3); color: var(--fg); }
    .value { text-align: center; margin-bottom: 10px; }
    .value .big { font-size: 30px; font-weight: 700; letter-spacing: -.5px; font-variant-numeric: tabular-nums; }
    .value .sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
    input[type=range] { width: 100%; accent-color: var(--accent); margin: 6px 0 10px; cursor: pointer; }
    .row { display: flex; gap: 6px; }
    .row button, .chips button {
      flex: 1; border: 1px solid var(--border); border-radius: 8px; padding: 7px 0; background: var(--bg2);
      color: var(--fg); cursor: pointer; font-size: 12px; font-weight: 600;
    }
    .row button:hover, .chips button:hover { background: var(--bg3); }
    .chips { display: flex; gap: 6px; margin-top: 8px; }
    .chips button { color: var(--muted); font-weight: 500; }
    .chips button.sel { color: var(--fg); border-color: var(--accent); }
    .disabled .modes, .disabled .value, .disabled input, .disabled .row, .disabled .chips { opacity: .4; pointer-events: none; }
    .foot { margin-top: 14px; padding-top: 10px; border-top: 1px solid var(--border); color: var(--muted); font-size: 11px; display: flex; justify-content: space-between; gap: 8px; }
    .foot .warn { color: #ff8a80; }
  `;

  const ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 7v10M21 12h0"/></svg>`;

  const ui = {};

  function buildUI() {
    const host = document.createElement("div");
    host.id = "deezer-pitch-changer";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `
      <style>${STYLE}</style>
      <div class="root">
        <div class="panel" part="panel">
          <div class="head">
            <span class="title">Pitch changer</span>
            <button class="switch" title="Turn on / off (Alt+Shift+P)"></button>
          </div>
          <div class="body">
            <div class="modes">
              ${Object.entries(MODES).map(([id, m]) => `<button data-mode="${id}">${m.label}</button>`).join("")}
            </div>
            <div class="value"><div class="big"></div><div class="sub"></div></div>
            <input type="range">
            <div class="row">
              <button data-step="-1"></button>
              <button data-reset>Reset</button>
              <button data-step="1"></button>
            </div>
            <div class="chips"></div>
          </div>
          <div class="foot"><span class="status"></span><span>Alt+P</span></div>
        </div>
        <button class="fab" title="Pitch changer (Alt+P)">${ICON}<span class="label"></span></button>
      </div>`;

    const $ = (sel) => shadow.querySelector(sel);
    Object.assign(ui, {
      host,
      root: $(".root"),
      panel: $(".panel"),
      fab: $(".fab"),
      label: $(".fab .label"),
      power: $(".switch"),
      big: $(".value .big"),
      sub: $(".value .sub"),
      slider: $("input[type=range]"),
      minus: $("[data-step='-1']"),
      plus: $("[data-step='1']"),
      chips: $(".chips"),
      status: $(".status"),
      modeButtons: [...shadow.querySelectorAll("[data-mode]")],
    });

    ui.power.addEventListener("click", () => update({ enabled: !settings.enabled }));
    for (const b of ui.modeButtons) b.addEventListener("click", () => update({ mode: b.dataset.mode }));
    ui.slider.addEventListener("input", () => setModeValue(Number(ui.slider.value)));
    ui.slider.addEventListener("dblclick", resetValue);
    shadow.querySelector("[data-reset]").addEventListener("click", resetValue);
    ui.minus.addEventListener("click", () => stepValue(-1));
    ui.plus.addEventListener("click", () => stepValue(1));
    ui.chips.addEventListener("click", (e) => {
      const b = e.target.closest("button[data-value]");
      if (b) setModeValue(Number(b.dataset.value));
    });
    ui.panel.addEventListener("wheel", (e) => {
      if (e.target !== ui.slider) return;
      e.preventDefault();
      stepValue(e.deltaY < 0 ? 1 : -1, true);
    }, { passive: false });

    setupDrag();
    attachHost();
    render();
  }

  function attachHost() {
    if (!ui.host || ui.host.isConnected || !document.body) return;
    document.body.appendChild(ui.host);
    placeHost();
  }

  // ---------- position & dragging

  function placeHost() {
    const margin = 12;
    const w = ui.fab.offsetWidth || 90;
    const h = ui.fab.offsetHeight || 36;
    let pos = settings.position;
    if (!pos) pos = { x: window.innerWidth - w - 24, y: window.innerHeight - h - 104 };
    const x = clamp(pos.x, margin, Math.max(margin, window.innerWidth - w - margin));
    const y = clamp(pos.y, margin, Math.max(margin, window.innerHeight - h - margin));
    Object.assign(ui.root.style, { left: `${x}px`, top: `${y}px` });
    // Open the panel on the side that has room.
    ui.root.classList.toggle("below", y < 420);
    ui.root.classList.toggle("left", x + w < 330);
  }

  function setupDrag() {
    let start = null;
    let dragged = false;
    ui.fab.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const rect = ui.root.getBoundingClientRect();
      start = { px: e.clientX, py: e.clientY, x: rect.left, y: rect.top };
      dragged = false;
      ui.fab.setPointerCapture(e.pointerId);
    });
    ui.fab.addEventListener("pointermove", (e) => {
      if (!start) return;
      const dx = e.clientX - start.px;
      const dy = e.clientY - start.py;
      if (!dragged && Math.hypot(dx, dy) < 5) return;
      dragged = true;
      settings.position = { x: start.x + dx, y: start.y + dy };
      placeHost();
    });
    ui.fab.addEventListener("pointerup", () => {
      if (!start) return;
      start = null;
      if (dragged) saveSettings();
      else update({ panelOpen: !settings.panelOpen });
    });
    window.addEventListener("resize", placeHost);
  }

  // ---------- values

  function modeValue() {
    return settings[settings.mode];
  }

  function setModeValue(value) {
    const v = settings.mode === "pitch"
      ? clamp(round(value, 0.01), SEMITONES_MIN, SEMITONES_MAX)
      : clamp(round(value, 0.01), SPEED_MIN, SPEED_MAX);
    update({ [settings.mode]: v });
  }

  function resetValue() {
    setModeValue(settings.mode === "pitch" ? 0 : 1);
  }

  // Buttons: one semitone in "vinyl" and "pitch" modes, 5 % in "speed" mode. Fine = wheel on the slider.
  function stepValue(direction, fine) {
    const v = modeValue();
    if (settings.mode === "pitch") {
      const step = fine ? 0.1 : 1;
      setModeValue(fine ? v + direction * step : Math.round(v) + direction * step);
    } else if (settings.mode === "vinyl" && !fine) {
      const st = Math.round(12 * Math.log2(v)) + direction;
      setModeValue(Math.pow(2, st / 12));
    } else {
      const step = fine ? 0.01 : 0.05;
      setModeValue(round(v, step) + direction * step);
    }
  }

  function update(patch) {
    Object.assign(settings, patch);
    saveSettings();
    applyAll();
    render();
  }

  function render() {
    if (!ui.root) return;
    const mode = settings.mode;
    const value = modeValue();
    const fx = effect();

    ui.label.textContent = badgeText();
    placeHost(); // the button width follows its label
    ui.fab.classList.toggle("active", settings.enabled && !isNeutral(fx));
    ui.fab.classList.toggle("off", !settings.enabled);
    ui.panel.classList.toggle("open", settings.panelOpen);
    ui.panel.classList.toggle("disabled", !settings.enabled);
    ui.power.classList.toggle("on", settings.enabled);
    for (const b of ui.modeButtons) b.classList.toggle("sel", b.dataset.mode === mode);

    if (mode === "pitch") {
      Object.assign(ui.slider, { min: SEMITONES_MIN, max: SEMITONES_MAX, step: 0.01 });
      ui.big.textContent = `${formatSemitones(value)} semitones`;
      const cents = Math.round(value * 100);
      ui.sub.textContent = `${cents > 0 ? "+" : cents < 0 ? "−" : ""}${Math.abs(cents)} cents · same speed`;
      ui.minus.textContent = "−1 st";
      ui.plus.textContent = "+1 st";
    } else {
      Object.assign(ui.slider, { min: SPEED_MIN, max: SPEED_MAX, step: 0.01 });
      ui.big.textContent = `${formatRatio(value)}`;
      ui.sub.textContent = mode === "vinyl"
        ? `${Math.round(value * 100)} % · ${formatSemitones(12 * Math.log2(value))} semitones`
        : `${Math.round(value * 100)} % · same pitch`;
      ui.minus.textContent = mode === "vinyl" ? "−1 st" : "−5 %";
      ui.plus.textContent = mode === "vinyl" ? "+1 st" : "+5 %";
    }
    ui.slider.value = String(value);

    ui.chips.innerHTML = PRESETS[mode]
      .map((p) => `<button data-value="${p.value}" class="${Math.abs(p.value - value) < 0.006 ? "sel" : ""}">${p.label}</button>`)
      .join("");

    updateStatus();
  }

  function updateStatus() {
    if (!ui.status) return;
    const count = mediaElements().length;
    if (engine.error && settings.mode === "pitch") {
      ui.status.innerHTML = `<span class="warn">Audio engine unavailable</span>`;
    } else if (count === 0) {
      ui.status.textContent = "Play a track to apply";
    } else {
      ui.status.textContent = `v${VERSION} · player detected`;
    }
  }

  // ---------------------------------------------------------------- boot

  installHooks();

  window.addEventListener("keydown", (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || e.code !== "KeyP") return;
    e.preventDefault();
    e.stopPropagation();
    if (e.shiftKey) update({ enabled: !settings.enabled });
    else update({ panelOpen: !settings.panelOpen });
  }, true);

  const boot = () => {
    try {
      buildUI();
    } catch (err) {
      warn("UI failed", err);
    }
    // Deezer's single-page app can rebuild parts of the page: keep the button attached.
    setInterval(attachHost, 2000);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();

  window.__deezerPitchChanger = {
    version: VERSION,
    settings,
    update,
    elements: mediaElements,
    engine,
  };
  log(`v${VERSION} loaded`);
}
