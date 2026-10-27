/* ============================================================================
   APEX PARKING 3D
   A complete mobile 3D parking simulator built with Three.js (r128).
   World, car, physics, inputs, missions, audio and UI are all self-contained.
   ========================================================================== */
(function () {
  'use strict';

  const bootScreen = document.getElementById('boot-screen');
  const bootMessage = document.getElementById('boot-message');
  const bootFill = document.getElementById('boot-fill');

  if (!window.THREE) {
    if (bootScreen) {
      bootScreen.classList.add('is-error');
      if (bootMessage) bootMessage.textContent = 'THREE.JS COULD NOT LOAD. RELOAD THE GAME OR CHECK THE VENDOR FOLDER.';
    }
    return;
  }

  const THREE = window.THREE;
  const $ = (id) => document.getElementById(id);
  const PI = Math.PI;
  const TAU = Math.PI * 2;

  /* --------------------------------------------------------------------------
     Small utilities
     -------------------------------------------------------------------------- */
  const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const damp = (a, b, lambda, dt) => a + (b - a) * (1 - Math.exp(-lambda * dt));
  const wrapAngle = (a) => {
    while (a > PI) a -= TAU;
    while (a < -PI) a += TAU;
    return a;
  };
  const angleDelta = (a, b) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
  const formatTime = (seconds) => {
    const s = Math.max(0, Math.floor(seconds));
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  const formatTimeLong = (seconds) => {
    if (!isFinite(seconds) || seconds <= 0) return '--:--';
    const s = Math.floor(seconds);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };
  const formatScore = (n) => Math.max(0, Math.round(n)).toLocaleString('en-US');

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function readJSON(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function writeJSON(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch (error) {
      /* Storage can be unavailable in private modes; the game still runs. */
    }
  }

  /* --------------------------------------------------------------------------
     Tunables
     -------------------------------------------------------------------------- */
  const CAR_HALF_WIDTH = 0.99;
  const CAR_HALF_LENGTH = 2.14;
  const WHEEL_BASE = 2.82;
  const MAX_WHEEL_ANGLE = 2.35;            // 135 degrees of visual wheel travel
  const MAX_STEER_LOW = 0.62;              // 35.5 degrees at parking speeds
  const MAX_SPEED_FORWARD = 9.2;           // m/s (~33 km/h)
  const MAX_SPEED_REVERSE = 4.2;
  const PARK_SPEED_THRESHOLD = 0.34;
  const PARK_HOLD_TIME = 0.9;
  const LOT = { minX: -29.2, maxX: 29.2, minZ: -27.0, maxZ: 25.0 };
  const SAVE_KEY = 'apexParking3d.save.v1';
  const CAMERA_MODES = [
    { id: 'chase', label: 'CHASE', toast: 'CHASE CAMERA' },
    { id: 'close', label: 'CLOSE', toast: 'CLOSE CHASE CAMERA' },
    { id: 'cockpit', label: 'COCKPIT', toast: 'DRIVER CAMERA' },
    { id: 'top', label: 'TOP', toast: 'PARKING CAMERA' }
  ];
  const DEBUG = /(?:\?|&)debug=1(?:&|$)/.test(window.location.search);
  const SELF_TEST = /(?:\?|&)selftest=1(?:&|$)/.test(window.location.search);
  const SHOT = (() => {
    const match = window.location.search.match(/[?&]shot=([a-z]+)/i);
    return match ? match[1].toLowerCase() : null;
  })();

  /* --------------------------------------------------------------------------
     Persistent progress and settings
     -------------------------------------------------------------------------- */
  const DEFAULT_SETTINGS = {
    sound: true,
    arrows: false,
    shake: true,
    sensitivity: 100,
    quality: 'auto'
  };

  const DEFAULT_SAVE = {
    version: 1,
    unlocked: 1,
    stars: {},
    bestTimes: {},
    settings: Object.assign({}, DEFAULT_SETTINGS)
  };

  function sanitiseSave(raw) {
    const base = JSON.parse(JSON.stringify(DEFAULT_SAVE));
    if (!raw || typeof raw !== 'object') return base;
    base.unlocked = clamp(parseInt(raw.unlocked, 10) || 1, 1, 8);
    if (raw.stars && typeof raw.stars === 'object') {
      for (let i = 0; i < 8; i += 1) {
        const value = parseInt(raw.stars[i], 10);
        if (value > 0) {
          base.stars[i] = clamp(value, 1, 3);
          base.unlocked = Math.max(base.unlocked, Math.min(8, i + 2));
        }
      }
    }
    if (raw.bestTimes && typeof raw.bestTimes === 'object') {
      for (let i = 0; i < 8; i += 1) {
        const value = Number(raw.bestTimes[i]);
        if (Number.isFinite(value) && value > 0) base.bestTimes[i] = value;
      }
    }
    if (raw.settings && typeof raw.settings === 'object') {
      const s = raw.settings;
      base.settings.sound = s.sound !== false;
      base.settings.arrows = s.arrows === true;
      base.settings.shake = s.shake !== false;
      base.settings.sensitivity = clamp(parseInt(s.sensitivity, 10) || 100, 60, 140);
      base.settings.quality = ['auto', 'high', 'performance'].indexOf(s.quality) >= 0 ? s.quality : 'auto';
    }
    return base;
  }

  let save = sanitiseSave(readJSON(SAVE_KEY, null));
  const settings = save.settings;

  function persist() {
    save.settings = settings;
    writeJSON(SAVE_KEY, save);
  }

  /* --------------------------------------------------------------------------
     Game state
     -------------------------------------------------------------------------- */
  const state = {
    mode: 'boot',
    levelIndex: 0,
    cameraMode: 0,
    levelTime: 0,
    contacts: 0,
    parkHold: 0,
    started: false,
    completeDelay: 0,
    collisionCooldown: 0,
    shake: 0,
    validPark: false,
    parkStatus: { inside: false, aligned: false, stopped: false, valid: false },
    result: null,
    hudTick: 0,
    time: 0
  };

  const car = {
    x: 0,
    z: 0,
    yaw: 0,
    speed: 0,
    steer: 0,
    wheelSpin: 0,
    roll: 0,
    pitch: 0,
    prevSpeed: 0,
    accelSmooth: 0
  };

  const input = { gas: false, brake: false, left: false, right: false };
  const wheelInput = { angle: 0, target: 0, held: false, pointerId: null, lastAngle: 0 };
  const keys = Object.create(null);
  let gear = 'D';
  let level = null;
  let toastTimer = 0;
  let levelCardTimer = 0;

  /* --------------------------------------------------------------------------
     Audio engine — lightweight WebAudio, no external assets
     -------------------------------------------------------------------------- */
  const audio = {
    ctx: null,
    master: null,
    engineGain: null,
    engineFilter: null,
    oscA: null,
    oscB: null,
    noiseBuffer: null,
    muted: !settings.sound,
    started: false,

    init() {
      if (this.ctx) {
        if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
        return;
      }
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      try {
        const ctx = new Ctx();
        const master = ctx.createGain();
        master.gain.value = this.muted ? 0 : 0.65;
        const compressor = ctx.createDynamicsCompressor();
        compressor.threshold.value = -18;
        compressor.knee.value = 22;
        compressor.ratio.value = 7;
        compressor.attack.value = 0.004;
        compressor.release.value = 0.25;
        master.connect(compressor);
        compressor.connect(ctx.destination);

        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 340;
        filter.Q.value = 0.8;

        const engineGain = ctx.createGain();
        engineGain.gain.value = 0.0001;
        filter.connect(engineGain);
        engineGain.connect(master);

        const oscA = ctx.createOscillator();
        oscA.type = 'sawtooth';
        oscA.frequency.value = 52;
        const oscB = ctx.createOscillator();
        oscB.type = 'square';
        oscB.frequency.value = 26;
        const bGain = ctx.createGain();
        bGain.gain.value = 0.35;
        oscA.connect(filter);
        oscB.connect(bGain);
        bGain.connect(filter);
        oscA.start();
        oscB.start();

        this.ctx = ctx;
        this.master = master;
        this.engineGain = engineGain;
        this.engineFilter = filter;
        this.oscA = oscA;
        this.oscB = oscB;
        this.started = true;
        this.updateEngine(0, 0, false, false);
      } catch (error) {
        this.ctx = null;
      }
    },

    unlock() {
      this.init();
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
    },

    setMuted(muted) {
      this.muted = muted;
      if (this.ctx) {
        const now = this.ctx.currentTime;
        this.master.gain.cancelScheduledValues(now);
        this.master.gain.setTargetAtTime(muted ? 0 : 0.65, now, 0.05);
      }
    },

    updateEngine(speed, throttle, braking, active) {
      if (!this.ctx) return;
      const now = this.ctx.currentTime;
      const abs = Math.abs(speed);
      const freq = 46 + abs * 15 + (throttle ? 8 : 0);
      const gainTarget = active ? Math.min(0.055, 0.012 + abs * 0.0032 + (throttle ? 0.022 : 0)) : 0.0001;
      this.oscA.frequency.setTargetAtTime(freq, now, 0.09);
      this.oscB.frequency.setTargetAtTime(freq * 0.5, now, 0.12);
      this.engineFilter.frequency.setTargetAtTime(260 + abs * 90 + (throttle ? 150 : 0), now, 0.1);
      this.engineGain.gain.setTargetAtTime(this.muted ? 0.0001 : gainTarget, now, 0.09);
      if (braking) {
        this.engineGain.gain.setTargetAtTime(this.muted ? 0.0001 : 0.009, now, 0.06);
      }
    },

    blip(freq, duration, type, volume) {
      if (!this.ctx) return;
      if (this.muted) return;
      const now = this.ctx.currentTime;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq || 520, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(volume || 0.06, now + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + (duration || 0.16));
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(now);
      osc.stop(now + (duration || 0.16) + 0.03);
    },

    click() {
      this.unlock();
      this.blip(680, 0.07, 'triangle', 0.035);
    },

    gearShift() {
      this.unlock();
      this.blip(300, 0.1, 'square', 0.035);
      setTimeout(() => this.blip(420, 0.08, 'triangle', 0.03), 60);
    },

    hit(intensity) {
      if (!this.ctx || this.muted) return;
      const now = this.ctx.currentTime;
      if (!this.noiseBuffer) {
        const length = Math.floor(this.ctx.sampleRate * 0.32);
        const buffer = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < length; i += 1) {
          const env = Math.pow(1 - i / length, 2.4);
          data[i] = (Math.random() * 2 - 1) * env;
        }
        this.noiseBuffer = buffer;
      }
      const source = this.ctx.createBufferSource();
      source.buffer = this.noiseBuffer;
      const gain = this.ctx.createGain();
      gain.gain.value = clamp(intensity || 0.5, 0.15, 1) * 0.32;
      const filter = this.ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 780;
      source.connect(filter);
      filter.connect(gain);
      gain.connect(this.master);
      source.start(now);
      const thump = this.ctx.createOscillator();
      const thumpGain = this.ctx.createGain();
      thump.type = 'sine';
      thump.frequency.setValueAtTime(130, now);
      thump.frequency.exponentialRampToValueAtTime(52, now + 0.22);
      thumpGain.gain.setValueAtTime(0.0001, now);
      thumpGain.gain.exponentialRampToValueAtTime(0.14, now + 0.01);
      thumpGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.28);
      thump.connect(thumpGain);
      thumpGain.connect(this.master);
      thump.start(now);
      thump.stop(now + 0.3);
    },

    success() {
      this.unlock();
      if (!this.ctx || this.muted) return;
      const now = this.ctx.currentTime;
      [523.25, 659.25, 783.99, 1046.5].forEach((freq, index) => {
        const osc = this.ctx.createOscillator();
        const gain = this.ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.value = freq;
        const start = now + index * 0.09;
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.085, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.52);
        osc.connect(gain);
        gain.connect(this.master);
        osc.start(start);
        osc.stop(start + 0.55);
      });
    }
  };

  /* --------------------------------------------------------------------------
     Renderer, scene, camera
     -------------------------------------------------------------------------- */
  let renderer = null;
  let scene = null;
  let camera = null;
  let sunLight = null;
  let fillLight = null;
  let hemisphere = null;
  let canvasHost = null;
  let resizeTimer = 0;

  const camState = {
    pos: new THREE.Vector3(0, 4, 14),
    look: new THREE.Vector3(0, 1, 0),
    fov: 55,
    ready: false
  };

  function qualityPixelRatio() {
    const dpr = window.devicePixelRatio || 1;
    if (settings.quality === 'high') return Math.min(dpr, 2);
    if (settings.quality === 'performance') return 1;
    return Math.min(dpr, 1.6);
  }

  function shadowSize() {
    if (settings.quality === 'high') return 2048;
    if (settings.quality === 'performance') return 1024;
    return (navigator.hardwareConcurrency || 4) >= 6 ? 2048 : 1024;
  }

  function applyQuality() {
    if (!renderer) return;
    if (SELF_TEST) {
      /* Keep the automated suite quick on software WebGL. */
      renderer.setPixelRatio(0.5);
      renderer.shadowMap.enabled = false;
      onResize();
      return;
    }
    renderer.setPixelRatio(qualityPixelRatio());
    onResize();
    if (sunLight && sunLight.shadow) {
      sunLight.shadow.mapSize.width = shadowSize();
      sunLight.shadow.mapSize.height = shadowSize();
      if (sunLight.shadow.map) {
        sunLight.shadow.map.dispose();
        sunLight.shadow.map = null;
      }
    }
  }

  function setupRenderer() {
    canvasHost = $('canvas-host');
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false,
      preserveDrawingBuffer: false
    });
    renderer.setPixelRatio(qualityPixelRatio());
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputEncoding = THREE.sRGBEncoding;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.setClearColor(0x07111b, 1);
    if (canvasHost) canvasHost.appendChild(renderer.domElement);

    scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0x0a1622, 52, 215);

    camera = new THREE.PerspectiveCamera(55, window.innerWidth / window.innerHeight, 0.05, 420);
    camera.position.set(0, 4, 14);

    window.addEventListener('resize', scheduleResize, { passive: true });
    window.addEventListener('orientationchange', () => setTimeout(onResize, 220), { passive: true });
    if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleResize, { passive: true });
  }

  function scheduleResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(onResize, 90);
  }

  function onResize() {
    if (!renderer || !camera) return;
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    renderer.setPixelRatio(qualityPixelRatio());
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function setupLights() {
    hemisphere = new THREE.HemisphereLight(0x93b6e4, 0x1c1712, 0.72);
    scene.add(hemisphere);

    sunLight = new THREE.DirectionalLight(0xffc38a, 1.55);
    sunLight.position.set(-36, 45, 27);
    sunLight.target.position.set(0, 0, 0);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.width = shadowSize();
    sunLight.shadow.mapSize.height = shadowSize();
    sunLight.shadow.camera.left = -38;
    sunLight.shadow.camera.right = 38;
    sunLight.shadow.camera.top = 38;
    sunLight.shadow.camera.bottom = -38;
    sunLight.shadow.camera.near = 1;
    sunLight.shadow.camera.far = 130;
    sunLight.shadow.bias = -0.00045;
    sunLight.shadow.normalBias = 0.026;
    scene.add(sunLight);
    scene.add(sunLight.target);

    fillLight = new THREE.DirectionalLight(0x5c8fc9, 0.36);
    fillLight.position.set(28, 16, -32);
    scene.add(fillLight);
  }

  /* --------------------------------------------------------------------------
     Procedural textures — every visual ships inside the game, no downloads
     -------------------------------------------------------------------------- */
  const textureCache = {};
  const M = {};
  const G = {};

  function maxAnisotropy() {
    return renderer ? Math.min(4, renderer.capabilities.getMaxAnisotropy()) : 1;
  }

  function makeNoiseCanvas(size, base, variance, seed) {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    const random = mulberry32(seed || 1);
    const image = ctx.createImageData(size, size);
    for (let i = 0; i < size * size; i += 1) {
      const shade = clamp(base + (random() - 0.5) * variance, 0, 255);
      image.data[i * 4] = shade;
      image.data[i * 4 + 1] = shade;
      image.data[i * 4 + 2] = shade;
      image.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(image, 0, 0);
    return canvas;
  }

  function makeAsphaltTexture() {
    const canvas = makeNoiseCanvas(384, 42, 30, 41);
    const ctx = canvas.getContext('2d');
    const random = mulberry32(99);
    // Weathered patches
    for (let i = 0; i < 36; i += 1) {
      const x = random() * 384;
      const y = random() * 384;
      const r = 18 + random() * 78;
      const grad = ctx.createRadialGradient(x, y, 1, x, y, r);
      const dark = random() > 0.45;
      grad.addColorStop(0, dark ? 'rgba(14,18,23,0.13)' : 'rgba(125,132,138,0.05)');
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.fillRect(x - r, y - r, r * 2, r * 2);
    }
    // Fine aggregate
    for (let i = 0; i < 1400; i += 1) {
      ctx.fillStyle = random() > 0.5 ? 'rgba(190,198,205,0.08)' : 'rgba(0,0,0,0.13)';
      ctx.fillRect(random() * 384, random() * 384, 1, 1);
    }
    // Hairline cracks
    ctx.strokeStyle = 'rgba(8,11,15,0.28)';
    ctx.lineWidth = 1;
    for (let c = 0; c < 5; c += 1) {
      let x = random() * 384;
      let y = random() * 384;
      ctx.beginPath();
      ctx.moveTo(x, y);
      for (let s = 0; s < 8; s += 1) {
        x += (random() - 0.5) * 26;
        y += (random() - 0.5) * 26;
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(11, 10);
    texture.anisotropy = maxAnisotropy();
    texture.encoding = THREE.sRGBEncoding;
    return texture;
  }

  function makeConcreteTexture() {
    const canvas = makeNoiseCanvas(256, 130, 26, 17);
    const ctx = canvas.getContext('2d');
    const random = mulberry32(23);
    for (let i = 0; i < 12; i += 1) {
      ctx.strokeStyle = 'rgba(40,46,52,0.09)';
      ctx.lineWidth = 1;
      const y = random() * 256;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(256, y + (random() - 0.5) * 8);
      ctx.stroke();
    }
    for (let i = 0; i < 320; i += 1) {
      ctx.fillStyle = random() > 0.5 ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.07)';
      ctx.fillRect(random() * 256, random() * 256, 1.4, 1.4);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(4, 2);
    texture.anisotropy = maxAnisotropy();
    texture.encoding = THREE.sRGBEncoding;
    return texture;
  }

  function makeWindowTexture(seed, tint) {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const random = mulberry32(seed);
    const base = ctx.createLinearGradient(0, 0, 128, 256);
    base.addColorStop(0, tint || '#111b26');
    base.addColorStop(0.5, '#0c151e');
    base.addColorStop(1, '#070d14');
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, 128, 256);

    const cols = 5;
    const rows = 13;
    const marginX = 8;
    const marginY = 6;
    const cellW = (128 - marginX * 2) / cols;
    const cellH = (256 - marginY * 2) / rows;
    const windowW = cellW * 0.62;
    const windowH = cellH * 0.52;
    const palette = ['#ffd28a', '#ffe9bd', '#a7d8ff', '#d7ecff', '#e8b96f'];
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        const lit = random() < 0.56;
        const x = marginX + c * cellW + (cellW - windowW) / 2;
        const y = marginY + r * cellH + (cellH - windowH) / 2;
        if (lit) {
          const color = palette[Math.floor(random() * palette.length)];
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.44 + random() * 0.5;
          ctx.fillRect(x, y, windowW, windowH);
          ctx.globalAlpha = 1;
          if (random() > 0.74) {
            ctx.fillStyle = 'rgba(255,255,255,0.4)';
            ctx.fillRect(x + 1, y + 1, windowW - 2, 2);
          }
        } else {
          ctx.fillStyle = 'rgba(3,8,13,0.9)';
          ctx.fillRect(x, y, windowW, windowH);
          ctx.fillStyle = 'rgba(91,128,160,0.1)';
          ctx.fillRect(x, y, windowW, 1);
        }
      }
    }
    // Vertical structure bands
    ctx.fillStyle = 'rgba(5,10,16,0.82)';
    ctx.fillRect(0, 0, 5, 256);
    ctx.fillRect(123, 0, 5, 256);
    ctx.fillStyle = 'rgba(130,160,190,0.08)';
    for (let r = 0; r <= rows; r += 1) {
      ctx.fillRect(0, marginY + r * cellH - 2, 128, 1);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.encoding = THREE.sRGBEncoding;
    texture.anisotropy = maxAnisotropy();
    return texture;
  }

  function makeGlowTexture() {
    if (textureCache.glow) return textureCache.glow;
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(64, 64, 1, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.16, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.28)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
    const texture = new THREE.CanvasTexture(canvas);
    texture.encoding = THREE.sRGBEncoding;
    textureCache.glow = texture;
    return texture;
  }

  function makeContactTexture() {
    if (textureCache.contact) return textureCache.contact;
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createRadialGradient(64, 64, 8, 64, 64, 62);
    grad.addColorStop(0, 'rgba(0,0,0,0.72)');
    grad.addColorStop(0.55, 'rgba(0,0,0,0.32)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
    const texture = new THREE.CanvasTexture(canvas);
    texture.encoding = THREE.sRGBEncoding;
    textureCache.contact = texture;
    return texture;
  }

  function makeGroundArrowTexture() {
    if (textureCache.arrow) return textureCache.arrow;
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, 128, 256);
    ctx.fillStyle = 'rgba(236,232,218,0.72)';
    ctx.beginPath();
    ctx.moveTo(64, 12);
    ctx.lineTo(112, 94);
    ctx.lineTo(82, 94);
    ctx.lineTo(82, 240);
    ctx.lineTo(46, 240);
    ctx.lineTo(46, 94);
    ctx.lineTo(16, 94);
    ctx.closePath();
    ctx.fill();
    const texture = new THREE.CanvasTexture(canvas);
    texture.encoding = THREE.sRGBEncoding;
    texture.anisotropy = maxAnisotropy();
    textureCache.arrow = texture;
    return texture;
  }

  function makeTextDecal(text, options) {
    const opts = options || {};
    const canvas = document.createElement('canvas');
    canvas.width = opts.width || 256;
    canvas.height = opts.height || 128;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (opts.background) {
      ctx.fillStyle = opts.background;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    if (opts.border) {
      ctx.strokeStyle = opts.border;
      ctx.lineWidth = opts.borderWidth || 4;
      ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, canvas.width - ctx.lineWidth, canvas.height - ctx.lineWidth);
    }
    ctx.fillStyle = opts.color || '#f5b74a';
    ctx.font = `${opts.weight || 700} ${opts.fontSize || Math.floor(canvas.height * 0.5)}px ${opts.font || 'Orbitron, Trebuchet MS, sans-serif'}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    if (opts.letterSpacing) {
      const chars = String(text).split('');
      const total = chars.reduce((sum, ch) => sum + ctx.measureText(ch).width + opts.letterSpacing, 0) - opts.letterSpacing;
      let x = canvas.width / 2 - total / 2;
      chars.forEach((ch) => {
        ctx.textAlign = 'left';
        ctx.fillText(ch, x, canvas.height / 2 + (opts.offsetY || 0));
        x += ctx.measureText(ch).width + opts.letterSpacing;
      });
    } else {
      ctx.fillText(text, canvas.width / 2, canvas.height / 2 + (opts.offsetY || 0));
    }
    if (opts.subtext) {
      ctx.fillStyle = opts.subColor || 'rgba(255,255,255,0.7)';
      ctx.font = `600 ${opts.subSize || Math.floor(canvas.height * 0.14)}px ${opts.subFont || 'Rajdhani, Segoe UI, sans-serif'}`;
      ctx.fillText(opts.subtext, canvas.width / 2, canvas.height * 0.79);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.encoding = THREE.sRGBEncoding;
    texture.anisotropy = maxAnisotropy();
    return texture;
  }

  function makeSignTexture(title, subtitle, accent) {
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 320;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 1024, 320);
    grad.addColorStop(0, '#08111a');
    grad.addColorStop(1, '#111e28');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 1024, 320);
    ctx.strokeStyle = 'rgba(245,183,74,0.7)';
    ctx.lineWidth = 8;
    ctx.strokeRect(12, 12, 1000, 296);
    ctx.fillStyle = accent || '#f5b74a';
    ctx.beginPath();
    ctx.arc(142, 160, 76, 0, TAU);
    ctx.fill();
    ctx.fillStyle = '#0a1118';
    ctx.font = '900 112px Orbitron, Trebuchet MS, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('P', 142, 168);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#f4f8fb';
    ctx.font = '800 76px Orbitron, Trebuchet MS, sans-serif';
    ctx.fillText(title, 258, 126);
    ctx.fillStyle = 'rgba(245,183,74,0.9)';
    ctx.font = '600 32px Rajdhani, Segoe UI, sans-serif';
    ctx.fillText(subtitle, 262, 204);
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    ctx.fillRect(262, 236, 700, 2);
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '500 22px Rajdhani, Segoe UI, sans-serif';
    ctx.fillText('LEVEL 02  ·  SKYLINE DECK  ·  VALET ONLY', 262, 268);
    const texture = new THREE.CanvasTexture(canvas);
    texture.encoding = THREE.sRGBEncoding;
    texture.anisotropy = maxAnisotropy();
    return texture;
  }

  function createSharedAssets() {
    const asphalt = makeAsphaltTexture();
    const concrete = makeConcreteTexture();
    M.asphalt = new THREE.MeshStandardMaterial({ map: asphalt, color: 0x8e969d, roughness: 0.92, metalness: 0.04 });
    M.concrete = new THREE.MeshStandardMaterial({ map: concrete, color: 0xb6b8b5, roughness: 0.88, metalness: 0.05 });
    M.concreteDark = new THREE.MeshStandardMaterial({ map: concrete, color: 0x737b80, roughness: 0.92, metalness: 0.05 });
    M.line = new THREE.MeshStandardMaterial({ color: 0xded9c8, roughness: 0.74, metalness: 0.02 });
    M.lineYellow = new THREE.MeshStandardMaterial({ color: 0xe0b455, roughness: 0.72, metalness: 0.02 });
    M.steel = new THREE.MeshStandardMaterial({ color: 0x77828c, roughness: 0.34, metalness: 0.88 });
    M.darkMetal = new THREE.MeshStandardMaterial({ color: 0x1b2229, roughness: 0.46, metalness: 0.64 });
    M.rubber = new THREE.MeshStandardMaterial({ color: 0x131619, roughness: 0.92, metalness: 0.02 });
    M.glass = new THREE.MeshStandardMaterial({
      color: 0x7ea6bd,
      transparent: true,
      opacity: 0.16,
      roughness: 0.08,
      metalness: 0.4,
      side: THREE.DoubleSide,
      depthWrite: false
    });
    M.warmGlow = new THREE.MeshBasicMaterial({
      color: 0xffb867,
      transparent: true,
      opacity: 0.94
    });
    M.coolGlow = new THREE.MeshBasicMaterial({
      color: 0x9fe8ff,
      transparent: true,
      opacity: 0.86
    });
    M.treeTrunk = new THREE.MeshStandardMaterial({ color: 0x433026, roughness: 0.95 });
    M.treeLeaf = new THREE.MeshStandardMaterial({ color: 0x24422f, roughness: 0.9, metalness: 0.02 });
    M.treeLeafLight = new THREE.MeshStandardMaterial({ color: 0x345c3d, roughness: 0.88 });
    M.rimGold = new THREE.MeshStandardMaterial({ color: 0xd9a24a, metalness: 0.94, roughness: 0.22 });

    G.box = new THREE.BoxGeometry(1, 1, 1);
    G.plane = new THREE.PlaneGeometry(1, 1);
    G.cylinder = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
  }

  /* --------------------------------------------------------------------------
     Reflection environment and sky
     -------------------------------------------------------------------------- */
  function createEnvironmentMap() {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, '#07111f');
    grad.addColorStop(0.42, '#17293b');
    grad.addColorStop(0.54, '#b36d4a');
    grad.addColorStop(0.6, '#392c2d');
    grad.addColorStop(1, '#090e13');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 512, 256);
    const glow = ctx.createRadialGradient(120, 140, 4, 120, 140, 100);
    glow.addColorStop(0, 'rgba(255,210,153,0.95)');
    glow.addColorStop(0.2, 'rgba(255,160,90,0.4)');
    glow.addColorStop(1, 'rgba(255,160,90,0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, 512, 256);
    // City silhouette and window glints reflected in paintwork
    ctx.fillStyle = 'rgba(4,9,15,0.92)';
    for (let i = 0; i < 28; i += 1) {
      const w = 12 + (i % 5) * 6;
      const height = 18 + ((i * 37) % 52);
      ctx.fillRect(i * 19, 150 - height, w, height + 80);
    }
    for (let i = 0; i < 110; i += 1) {
      ctx.fillStyle = i % 3 ? 'rgba(255,198,120,0.5)' : 'rgba(150,210,255,0.4)';
      ctx.fillRect(10 + ((i * 23) % 490), 158 + ((i * 17) % 70), 1.6, 1.2);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.mapping = THREE.EquirectangularReflectionMapping;
    texture.encoding = THREE.sRGBEncoding;
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      pmrem.compileEquirectangularShader();
      const target = pmrem.fromEquirectangular(texture);
      scene.environment = target.texture;
      texture.dispose();
      pmrem.dispose();
    } catch (error) {
      scene.environment = null;
    }
  }

  function buildSky() {
    const skyGeo = new THREE.SphereGeometry(300, 28, 18);
    const skyMat = new THREE.ShaderMaterial({
      uniforms: {
        topColor: { value: new THREE.Color(0x06101d) },
        horizonColor: { value: new THREE.Color(0xd08252) },
        lowColor: { value: new THREE.Color(0x1a1418) },
        sunColor: { value: new THREE.Color(0xffd6a0) },
        sunDir: { value: new THREE.Vector3(-0.62, 0.5, 0.45).normalize() }
      },
      vertexShader: [
        'varying vec3 vDir;',
        'void main() {',
        '  vDir = normalize(position);',
        '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 topColor;',
        'uniform vec3 horizonColor;',
        'uniform vec3 lowColor;',
        'uniform vec3 sunColor;',
        'uniform vec3 sunDir;',
        'varying vec3 vDir;',
        'void main() {',
        '  float h = vDir.y;',
        '  vec3 col;',
        '  if (h > 0.0) {',
        '    col = mix(horizonColor, topColor, pow(clamp(h, 0.0, 1.0), 0.55));',
        '  } else {',
        '    col = mix(horizonColor, lowColor, clamp(-h * 4.0, 0.0, 1.0));',
        '  }',
        '  float sun = pow(max(dot(normalize(vDir), sunDir), 0.0), 260.0);',
        '  float halo = pow(max(dot(normalize(vDir), sunDir), 0.0), 9.0);',
        '  col += sunColor * sun * 1.7 + sunColor * halo * 0.12;',
        '  float haze = exp(-abs(h) * 11.0);',
        '  col += vec3(0.32, 0.18, 0.12) * haze * 0.28;',
        '  gl_FragColor = vec4(col, 1.0);',
        '}'
      ].join('\n'),
      side: THREE.BackSide,
      depthWrite: false,
      fog: false
    });
    const sky = new THREE.Mesh(skyGeo, skyMat);
    sky.renderOrder = -10;
    scene.add(sky);

    const starGeo = new THREE.BufferGeometry();
    const positions = [];
    const random = mulberry32(7);
    for (let i = 0; i < 260; i += 1) {
      const theta = random() * TAU;
      const phi = Math.acos(0.2 + random() * 0.78);
      const r = 240;
      const x = r * Math.sin(phi) * Math.cos(theta);
      const y = r * Math.cos(phi);
      const z = r * Math.sin(phi) * Math.sin(theta);
      positions.push(x, Math.abs(y) + 12, z);
    }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    const stars = new THREE.Points(starGeo, new THREE.PointsMaterial({
      color: 0xcfe4ff,
      size: 1.15,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      fog: false
    }));
    scene.add(stars);

    const sunSprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeGlowTexture(),
      color: 0xffc17a,
      transparent: true,
      opacity: 0.62,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false
    }));
    sunSprite.position.set(-176, 116, 128);
    sunSprite.scale.set(150, 150, 1);
    scene.add(sunSprite);
  }

  /* --------------------------------------------------------------------------
     City skyline and surrounding ground
     -------------------------------------------------------------------------- */
  const cityTextureSeeds = [
    { seed: 11, tint: '#111b26' },
    { seed: 24, tint: '#16232e' },
    { seed: 37, tint: '#0d1820' },
    { seed: 51, tint: '#1a2430' },
    { seed: 68, tint: '#101a23' },
    { seed: 79, tint: '#141d26' }
  ];

  function buildCity() {
    const cityGround = new THREE.Mesh(
      new THREE.PlaneGeometry(340, 340),
      new THREE.MeshStandardMaterial({ map: M.asphalt.map, color: 0x4b5157, roughness: 1, metalness: 0 })
    );
    cityGround.rotation.x = -PI / 2;
    cityGround.position.y = -0.12;
    cityGround.receiveShadow = false;
    scene.add(cityGround);

    // Raised pavements framing the deck
    const pavementMat = M.concreteDark;
    const strips = [
      { x: 0, z: -30.4, w: 68, d: 2.4 },
      { x: 0, z: 28.4, w: 68, d: 2.4 },
      { x: -32.6, z: 0, w: 2.4, d: 62 },
      { x: 32.6, z: 0, w: 2.4, d: 62 }
    ];
    strips.forEach((s) => {
      const mesh = new THREE.Mesh(G.box, pavementMat);
      mesh.scale.set(s.w, 0.22, s.d);
      mesh.position.set(s.x, -0.02, s.z);
      mesh.receiveShadow = true;
      scene.add(mesh);
    });

    const windowTextures = cityTextureSeeds.map((t) => makeWindowTexture(t.seed, t.tint));
    const buildingDefs = [
      { x: -55, z: -44, w: 20, d: 17, h: 58, t: 0 },
      { x: -31, z: -54, w: 17, d: 18, h: 40, t: 2 },
      { x: -8, z: -48, w: 16, d: 15, h: 70, t: 4 },
      { x: 13, z: -55, w: 21, d: 19, h: 47, t: 1 },
      { x: 37, z: -45, w: 17, d: 17, h: 62, t: 5 },
      { x: 58, z: -35, w: 19, d: 20, h: 38, t: 3 },
      { x: 48, z: -8, w: 18, d: 22, h: 54, t: 2 },
      { x: 44, z: 18, w: 16, d: 20, h: 43, t: 0 },
      { x: 57, z: 42, w: 20, d: 18, h: 66, t: 4 },
      { x: 23, z: 42, w: 17, d: 17, h: 49, t: 1 },
      { x: -3, z: 48, w: 20, d: 17, h: 31, t: 5 },
      { x: -29, z: 41, w: 20, d: 18, h: 44, t: 3 },
      { x: -54, z: 38, w: 18, d: 18, h: 63, t: 2 },
      { x: -49, z: 8, w: 17, d: 22, h: 51, t: 0 },
      { x: -56, z: -14, w: 19, d: 20, h: 36, t: 4 },
      { x: 75, z: -3, w: 22, d: 24, h: 82, t: 3 },
      { x: 20, z: 70, w: 26, d: 22, h: 59, t: 1 },
      { x: -20, z: 73, w: 24, d: 22, h: 72, t: 5 }
    ];

    const rooftopMat = new THREE.MeshStandardMaterial({ color: 0x1a222a, roughness: 0.85, metalness: 0.15 });
    const random = mulberry32(88);
    buildingDefs.forEach((def, index) => {
      const texture = windowTextures[def.t % windowTextures.length].clone();
      texture.needsUpdate = true;
      texture.repeat.set(Math.max(1, Math.round(def.w / 11)), Math.max(1, Math.round(def.h / 17)));
      const mat = new THREE.MeshStandardMaterial({
        map: texture,
        emissiveMap: texture,
        emissive: 0xffd9a0,
        emissiveIntensity: 0.6,
        color: 0x9aa8b4,
        roughness: 0.72,
        metalness: 0.24
      });
      const building = new THREE.Mesh(G.box, mat);
      building.scale.set(def.w, def.h, def.d);
      building.position.set(def.x, def.h / 2 - 0.5, def.z);
      building.castShadow = false;
      building.receiveShadow = false;
      scene.add(building);

      const cap = new THREE.Mesh(G.box, rooftopMat);
      cap.scale.set(def.w * 1.02, 0.7, def.d * 1.02);
      cap.position.set(def.x, def.h - 0.3, def.z);
      scene.add(cap);

      if (index % 3 === 0) {
        const antenna = new THREE.Mesh(G.cylinder, M.darkMetal);
        antenna.scale.set(0.12, 7 + random() * 8, 0.12);
        antenna.position.set(def.x + def.w * 0.22, def.h + 4, def.z - def.d * 0.18);
        scene.add(antenna);
        const beacon = new THREE.Mesh(G.box, new THREE.MeshBasicMaterial({ color: 0xff4438 }));
        beacon.scale.set(0.22, 0.22, 0.22);
        beacon.position.set(antenna.position.x, antenna.position.y + antenna.scale.y / 2, antenna.position.z);
        scene.add(beacon);
      }
      if (index % 4 === 1) {
        const podium = new THREE.Mesh(G.box, rooftopMat);
        podium.scale.set(def.w * 0.4, 6, def.d * 0.4);
        podium.position.set(def.x - def.w * 0.18, def.h + 2.6, def.z + def.d * 0.15);
        scene.add(podium);
      }
    });

    // Palm-like accent trees on the pavements
    addCityTree(-38, -30.7, 1.15);
    addCityTree(38, 28.9, 1.05);
    addCityTree(-33.4, 22, 0.92);
    addCityTree(33.2, -22, 0.96);
  }

  function addCityTree(x, z, scale) {
    const group = new THREE.Group();
    const trunk = new THREE.Mesh(G.cylinder, M.treeTrunk);
    trunk.scale.set(0.22 * scale, 3.1 * scale, 0.22 * scale);
    trunk.position.y = 1.55 * scale;
    group.add(trunk);
    for (let i = 0; i < 5; i += 1) {
      const leaf = new THREE.Mesh(new THREE.IcosahedronGeometry(0.95 * scale, 0), i % 2 ? M.treeLeaf : M.treeLeafLight);
      const angle = (i / 5) * TAU;
      leaf.position.set(Math.cos(angle) * 0.72 * scale, 3.1 * scale + (i % 3) * 0.36 * scale, Math.sin(angle) * 0.72 * scale);
      leaf.scale.set(1, 0.72, 1);
      leaf.castShadow = true;
      group.add(leaf);
    }
    const top = new THREE.Mesh(new THREE.IcosahedronGeometry(0.8 * scale, 0), M.treeLeafLight);
    top.position.y = 4 * scale;
    group.add(top);
    group.position.set(x, 0, z);
    scene.add(group);
  }

  /* --------------------------------------------------------------------------
     Parking deck — slab, perimeter, bays, canopy, lighting and props
     -------------------------------------------------------------------------- */
  const staticColliders = [];
  const bays = { north: [], south: [], parallel: null };

  function addStaticCollider(x, z, hw, hd, tag) {
    staticColliders.push({ x: x, z: z, hw: hw, hd: hd, tag: tag || 'structure' });
  }

  function addBox(w, h, d, x, y, z, material, options) {
    const opts = options || {};
    const mesh = new THREE.Mesh(G.box, material);
    mesh.scale.set(w, h, d);
    mesh.position.set(x, y, z);
    if (opts.rotationY) mesh.rotation.y = opts.rotationY;
    mesh.castShadow = opts.cast !== false;
    mesh.receiveShadow = opts.receive !== false;
    scene.add(mesh);
    return mesh;
  }

  function addGroundPlane(w, d, x, z, y, material) {
    const mesh = new THREE.Mesh(G.plane, material);
    mesh.scale.set(w, d, 1);
    mesh.rotation.x = -PI / 2;
    mesh.position.set(x, y, z);
    mesh.receiveShadow = true;
    scene.add(mesh);
    return mesh;
  }

  function addStripe(w, d, x, z, material, y) {
    return addBox(w, 0.018, d, x, y === undefined ? 0.018 : y, z, material || M.line, {
      cast: false,
      receive: false
    });
  }

  function addGlowSprite(x, y, z, scale, color, opacity) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeGlowTexture(),
      color: color === undefined ? 0xffb066 : color,
      transparent: true,
      opacity: opacity === undefined ? 0.55 : opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false
    }));
    sprite.position.set(x, y, z);
    sprite.scale.set(scale, scale, 1);
    scene.add(sprite);
    return sprite;
  }

  function addFloorText(text, w, d, x, z, options) {
    const opts = options || {};
    const texture = makeTextDecal(text, {
      width: opts.width || 512,
      height: opts.height || 128,
      fontSize: opts.fontSize || 78,
      color: opts.color || 'rgba(236,232,220,0.5)',
      letterSpacing: opts.letterSpacing || 5,
      weight: opts.weight || 700,
      font: opts.font || 'Orbitron, Trebuchet MS, sans-serif'
    });
    const material = new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: opts.opacity === undefined ? 1 : opts.opacity,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2
    });
    const mesh = new THREE.Mesh(G.plane, material);
    mesh.scale.set(w, d, 1);
    mesh.rotation.set(-PI / 2, 0, opts.flip ? PI : 0);
    mesh.position.set(x, opts.y === undefined ? 0.028 : opts.y, z);
    mesh.renderOrder = 2;
    scene.add(mesh);
    return mesh;
  }

  function createBays() {
    for (let i = 0; i < 12; i += 1) {
      bays.north.push({
        code: 'A-' + String(i + 1).padStart(2, '0'),
        x: -17.6 + i * 3.2,
        z: -21.4,
        w: 3.2,
        d: 5.2,
        yaw: 0,
        row: 'north',
        index: i
      });
    }
    for (let i = 0; i < 10; i += 1) {
      bays.south.push({
        code: 'B-' + String(i + 1).padStart(2, '0'),
        x: -14.4 + i * 3.2,
        z: 11.6,
        w: 3.2,
        d: 5.2,
        yaw: 0,
        row: 'south',
        index: i
      });
    }
    bays.parallel = {
      code: 'C-01',
      x: 27.4,
      z: 2.1,
      w: 2.8,
      d: 5.8,
      yaw: 0,
      row: 'parallel',
      index: 0,
      parallel: true
    };
  }

  function drawBay(bay) {
    const halfW = bay.w / 2;
    const halfD = bay.d / 2;
    const mat = bay.parallel ? M.lineYellow : M.line;
    if (bay.parallel) {
      addStripe(0.12, bay.d, bay.x - halfW, bay.z, mat);
      addStripe(0.12, bay.d, bay.x + halfW, bay.z, mat);
      addStripe(bay.w, 0.12, bay.x, bay.z - halfD, mat);
      addStripe(bay.w, 0.12, bay.x, bay.z + halfD, mat);
      // Diagonal ticks at either end signal a parallel slot
      for (let i = 0; i < 4; i += 1) {
        const tick = addStripe(0.1, 0.72, bay.x - halfW + 0.35 + i * 0.62, bay.z - halfD + 0.55, mat);
        tick.rotation.y = PI / 4;
        const tick2 = addStripe(0.1, 0.72, bay.x - halfW + 0.35 + i * 0.62, bay.z + halfD - 0.55, mat);
        tick2.rotation.y = -PI / 4;
      }
    } else {
      addStripe(0.12, bay.d, bay.x - halfW, bay.z, mat);
      addStripe(0.12, bay.d, bay.x + halfW, bay.z, mat);
      addStripe(bay.w, 0.12, bay.x, bay.z + (bay.z < 0 ? -halfD : halfD), mat);
    }
    if (!bay.parallel) {
      addFloorText(
        bay.code,
        1.7,
        0.85,
        bay.x,
        bay.z + (bay.z < 0 ? halfD - 0.72 : -halfD + 0.72),
        {
          width: 256,
          height: 128,
          fontSize: 62,
          color: 'rgba(236,232,220,0.44)',
          letterSpacing: 6,
          flip: bay.z > 0
        }
      );
    }
  }

  function buildParkingLines() {
    // North row boundary lines
    for (let i = 0; i <= 12; i += 1) {
      addStripe(0.12, 5.2, -19.2 + i * 3.2, -21.4, M.line);
    }
    addStripe(38.4, 0.12, 0, -24.0, M.line);
    // South row boundary lines
    for (let i = 0; i <= 10; i += 1) {
      addStripe(0.12, 5.2, -16.0 + i * 3.2, 11.6, M.line);
    }
    addStripe(32.0, 0.12, 0, 14.2, M.line);

    bays.north.forEach(drawBay);
    bays.south.forEach(drawBay);
    drawBay(bays.parallel);

    // Lane centre dashes
    for (let x = -23.4; x <= 23.4; x += 3.4) {
      addStripe(1.7, 0.14, x, -4.4, M.line, 0.016);
    }
    // East parallel lane dashes
    for (let z = -14; z <= -7; z += 3.4) {
      addStripe(0.14, 1.7, 22.2, z, M.line, 0.016);
    }

    // Direction arrows
    const arrowMat = new THREE.MeshBasicMaterial({
      map: makeGroundArrowTexture(),
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2
    });
    [-13.2, 9.6, 23.8].forEach((x, index) => {
      const arrow = new THREE.Mesh(G.plane, arrowMat);
      arrow.scale.set(2.1, 4.2, 1);
      arrow.rotation.x = -PI / 2;
      if (index === 1) arrow.rotation.z = PI;
      arrow.position.set(x, 0.026, index === 1 ? 2.2 : -1.6);
      scene.add(arrow);
    });

    addFloorText('SLOW', 3.4, 1.7, 0, 18.6, {
      width: 512,
      height: 256,
      fontSize: 170,
      color: 'rgba(228,222,205,0.36)',
      letterSpacing: 16
    });

    // Large faded parking roundel in the middle of the deck
    const roundelMat = new THREE.MeshBasicMaterial({
      map: makeTextDecal('P', { width: 512, height: 512, fontSize: 350, color: 'rgba(232,226,210,0.13)' }),
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1
    });
    const roundel = new THREE.Mesh(G.plane, roundelMat);
    roundel.scale.set(9.4, 9.4, 1);
    roundel.rotation.x = -PI / 2;
    roundel.position.set(0, 0.022, -3.2);
    scene.add(roundel);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(4.55, 4.72, 64),
      new THREE.MeshBasicMaterial({ color: 0xd9d4c4, transparent: true, opacity: 0.18, depthWrite: false })
    );
    ring.rotation.x = -PI / 2;
    ring.position.set(0, 0.022, -3.2);
    scene.add(ring);
  }

  function buildDeckPerimeter() {
    const wallTop = 0.55;
    const railTop = 1.46;

    // North and south parapets
    addBox(62, wallTop, 1.1, 0, wallTop / 2, -27.55, M.concreteDark, { cast: false });
    addBox(62, wallTop, 1.1, 0, wallTop / 2, 25.55, M.concreteDark, { cast: false });
    // East and west parapets
    addBox(1.1, wallTop, 53.1, -29.75, wallTop / 2, -1, M.concreteDark, { cast: false });
    addBox(1.1, wallTop, 53.1, 29.75, wallTop / 2, -1, M.concreteDark, { cast: false });

    const glassHeight = railTop - wallTop;
    addBox(60.9, glassHeight, 0.05, 0, wallTop + glassHeight / 2, -27.55, M.glass, { cast: false, receive: false });
    addBox(60.9, glassHeight, 0.05, 0, wallTop + glassHeight / 2, 25.55, M.glass, { cast: false, receive: false });
    addBox(0.05, glassHeight, 52.1, -29.75, wallTop + glassHeight / 2, -1, M.glass, { cast: false, receive: false });
    addBox(0.05, glassHeight, 52.1, 29.75, wallTop + glassHeight / 2, -1, M.glass, { cast: false, receive: false });

    const postMat = M.steel;
    for (let x = -30; x <= 30; x += 4) {
      addBox(0.09, glassHeight + 0.04, 0.09, x, wallTop + glassHeight / 2, -27.55, postMat, { cast: false });
      addBox(0.09, glassHeight + 0.04, 0.09, x, wallTop + glassHeight / 2, 25.55, postMat, { cast: false });
    }
    for (let z = -25; z <= 23; z += 4) {
      addBox(0.09, glassHeight + 0.04, 0.09, -29.75, wallTop + glassHeight / 2, z, postMat, { cast: false });
      addBox(0.09, glassHeight + 0.04, 0.09, 29.75, wallTop + glassHeight / 2, z, postMat, { cast: false });
    }

    // Stainless top rails + warm LED accent
    addBox(61.2, 0.09, 0.13, 0, railTop, -27.55, postMat, { cast: false });
    addBox(61.2, 0.09, 0.13, 0, railTop, 25.55, postMat, { cast: false });
    addBox(0.13, 0.09, 52.4, -29.75, railTop, -1, postMat, { cast: false });
    addBox(0.13, 0.09, 52.4, 29.75, railTop, -1, postMat, { cast: false });

    const led = new THREE.MeshBasicMaterial({ color: 0xffc06a, transparent: true, opacity: 0.72 });
    addBox(60.4, 0.024, 0.024, 0, 1.41, -27.98, led, { cast: false, receive: false });
    addBox(60.4, 0.024, 0.024, 0, 1.41, 25.98, led, { cast: false, receive: false });
    addBox(0.024, 0.024, 51.6, -30.18, 1.41, -1, led, { cast: false, receive: false });
    addBox(0.024, 0.024, 51.6, 30.18, 1.41, -1, led, { cast: false, receive: false });

    // Solid collision perimeter (inner faces match LOT bounds)
    addStaticCollider(0, -28.15, 31, 1.15, 'wall');
    addStaticCollider(0, 26.15, 31, 1.15, 'wall');
    addStaticCollider(-30.25, -1, 1.05, 27.5, 'wall');
    addStaticCollider(30.25, -1, 1.05, 27.5, 'wall');

    // Corner columns
    [[-29.4, -27.2], [29.4, -27.2], [-29.4, 25.2], [29.4, 25.2]].forEach((c) => {
      addBox(0.75, 3.4, 0.75, c[0], 1.7, c[1], M.concreteDark);
      addBox(0.9, 0.16, 0.9, c[0], 3.48, c[1], M.darkMetal);
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), M.warmGlow);
      cap.position.set(c[0], 3.64, c[1]);
      scene.add(cap);
      addStaticCollider(c[0], c[1], 0.55, 0.55, 'column');
    });
  }

  function addLamp(x, z, inward, withLight) {
    const group = new THREE.Group();
    const base = new THREE.Mesh(G.cylinder, M.darkMetal);
    base.scale.set(0.44, 0.16, 0.44);
    base.position.y = 0.08;
    base.castShadow = true;
    group.add(base);

    const pole = new THREE.Mesh(G.cylinder, M.steel);
    pole.scale.set(0.14, 5.3, 0.14);
    pole.position.y = 2.7;
    pole.castShadow = true;
    group.add(pole);

    const head = new THREE.Mesh(G.box, M.darkMetal);
    head.scale.set(0.62, 0.2, 0.36);
    head.position.set(inward * 0.34, 5.32, 0);
    head.castShadow = true;
    group.add(head);

    const lens = new THREE.Mesh(G.box, M.warmGlow);
    lens.scale.set(0.5, 0.035, 0.26);
    lens.position.set(inward * 0.34, 5.21, 0);
    group.add(lens);

    group.position.set(x, 0, z);
    scene.add(group);

    addGlowSprite(x + inward * 0.34, 5.18, z, 4.4, 0xffb266, 0.42);

    if (withLight) {
      const light = new THREE.PointLight(0xffb066, 1.35, 20, 2);
      light.position.set(x + inward * 0.34, 5.0, z);
      scene.add(light);
    }

    // Soft pool of light on the asphalt
    const pool = new THREE.Mesh(
      G.plane,
      new THREE.MeshBasicMaterial({
        map: makeGlowTexture(),
        color: 0xffa85c,
        transparent: true,
        opacity: 0.13,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      })
    );
    pool.rotation.x = -PI / 2;
    pool.scale.set(7.5, 7.5, 1);
    pool.position.set(x + inward * 0.9, 0.018, z);
    scene.add(pool);

    addStaticCollider(x, z, 0.3, 0.3, 'lamp');
  }

  function addPlanter(x, z) {
    addBox(2.6, 0.62, 1.3, x, 0.31, z, M.concrete);
    addBox(2.3, 0.1, 1.02, x, 0.63, z, M.darkMetal, { cast: false });
    const soil = new THREE.MeshStandardMaterial({ color: 0x201a14, roughness: 1 });
    addBox(2.16, 0.06, 0.9, x, 0.67, z, soil, { cast: false });
    const random = mulberry32(Math.floor(Math.abs(x * 7 + z * 13)));
    for (let i = 0; i < 4; i += 1) {
      const bush = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.42 + random() * 0.12, 0),
        i % 2 ? M.treeLeaf : M.treeLeafLight
      );
      bush.position.set(x - 0.85 + i * 0.56, 0.88 + random() * 0.12, z + (random() - 0.5) * 0.34);
      bush.scale.set(1, 0.82, 1);
      bush.castShadow = true;
      scene.add(bush);
    }
    addStaticCollider(x, z, 1.34, 0.7, 'planter');
  }

  function buildCanopy() {
    const cx = -11.2;
    const cz = -20.8;
    const roofY = 3.46;

    addBox(17.2, 0.32, 9.0, cx, roofY, cz, M.darkMetal);
    addBox(17.4, 0.08, 9.2, cx, roofY + 0.2, cz, M.steel, { cast: false });
    // Gold trim
    addBox(17.4, 0.06, 0.1, cx, roofY - 0.18, cz - 4.55, M.lineYellow, { cast: false });
    addBox(17.4, 0.06, 0.1, cx, roofY - 0.18, cz + 4.55, M.lineYellow, { cast: false });

    // Recessed light panels beneath the canopy
    for (let i = 0; i < 6; i += 1) {
      const px = cx - 6.5 + i * 2.6;
      addBox(1.5, 0.05, 0.28, px, roofY - 0.19, cz, M.warmGlow, { cast: false, receive: false });
      addGlowSprite(px, roofY - 0.3, cz, 2.4, 0xffbd7a, 0.2);
    }
    const canopyLight = new THREE.PointLight(0xffbd7a, 1.25, 16, 2);
    canopyLight.position.set(cx, 3.0, cz);
    scene.add(canopyLight);

    // Support columns: two on the lane edge, two against the rear walkway
    [[-19.1, -17.0], [-3.3, -17.0], [-19.1, -25.3], [-3.3, -25.3]].forEach((p) => {
      const column = new THREE.Mesh(G.cylinder, M.steel);
      column.scale.set(0.42, 3.3, 0.42);
      column.position.set(p[0], 1.65, p[1]);
      column.castShadow = true;
      scene.add(column);
      addBox(0.52, 0.1, 0.52, p[0], 0.05, p[1], M.darkMetal, { cast: false });
      addStaticCollider(p[0], p[1], 0.32, 0.32, 'column');
    });

    // VIP fascia sign
    const vipTexture = makeTextDecal('VIP VALET', {
      width: 640,
      height: 120,
      fontSize: 64,
      color: '#f5c477',
      letterSpacing: 14
    });
    const vip = new THREE.Mesh(
      G.plane,
      new THREE.MeshBasicMaterial({ map: vipTexture, transparent: true, depthWrite: false })
    );
    vip.scale.set(4.6, 0.9, 1);
    vip.position.set(cx, 3.05, cz + 4.56);
    scene.add(vip);
  }

  function buildSignage() {
    const signTexture = makeSignTexture('APEX PARKING', 'SKYLINE VALET · LEVEL P2');
    const sign = new THREE.Mesh(
      G.plane,
      new THREE.MeshBasicMaterial({ map: signTexture, transparent: false })
    );
    sign.scale.set(9.6, 3.0, 1);
    sign.rotation.y = PI;
    sign.position.set(0, 4.35, 24.94);
    scene.add(sign);
    addBox(9.9, 3.2, 0.24, 0, 4.35, 25.14, M.darkMetal, { cast: false });

    // Wall decals
    const p2Texture = makeTextDecal('P2', {
      width: 384,
      height: 384,
      fontSize: 210,
      color: 'rgba(240,196,116,0.55)'
    });
    const p2 = new THREE.Mesh(
      G.plane,
      new THREE.MeshBasicMaterial({ map: p2Texture, transparent: true, depthWrite: false })
    );
    p2.scale.set(3.4, 3.4, 1);
    p2.position.set(-22.6, 2.2, -26.94);
    scene.add(p2);

    const valetTexture = makeTextDecal('VALET', {
      width: 720,
      height: 100,
      fontSize: 62,
      color: 'rgba(236,232,220,0.32)',
      letterSpacing: 18
    });
    const valet = new THREE.Mesh(
      G.plane,
      new THREE.MeshBasicMaterial({ map: valetTexture, transparent: true, depthWrite: false })
    );
    valet.scale.set(7.0, 0.98, 1);
    valet.position.set(17.8, 1.5, -26.94);
    scene.add(valet);
  }

  function buildDeckDetails() {
    // Puddles catching the environment reflections
    const puddleMat = new THREE.MeshStandardMaterial({
      color: 0x0c141c,
      roughness: 0.08,
      metalness: 0.96,
      transparent: true,
      opacity: 0.62,
      depthWrite: false
    });
    const puddleDefs = [
      [2.4, 1.4, 2.8, 1.1],
      [-8.4, -8.0, 2.1, 0.8],
      [12.6, 4.6, 2.4, 0.9],
      [24.4, -6.6, 1.7, 0.7],
      [-20.3, 13.6, 2.6, 1.0]
    ];
    puddleDefs.forEach((p) => {
      const puddle = new THREE.Mesh(new THREE.CircleGeometry(1, 22), puddleMat);
      puddle.scale.set(p[2], p[3], 1);
      puddle.rotation.x = -PI / 2;
      puddle.rotation.z = p[0] * 0.3;
      puddle.position.set(p[0], 0.008, p[1]);
      scene.add(puddle);
    });

    // Drainage grates
    const grateMat = new THREE.MeshStandardMaterial({ color: 0x2a3138, roughness: 0.55, metalness: 0.8 });
    [[-21.5, 2.4], [17.2, -15.0], [22.6, 19.4]].forEach((g) => {
      addBox(0.9, 0.03, 1.8, g[0], 0.017, g[1], grateMat, { cast: false, receive: false });
      for (let i = 0; i < 5; i += 1) {
        addBox(0.76, 0.012, 0.06, g[0], 0.034, g[1] - 0.62 + i * 0.31, M.darkMetal, { cast: false, receive: false });
      }
    });

    // Speed hump near the entrance
    addBox(11.8, 0.07, 0.62, 0, 0.035, 18.6, M.darkMetal, { cast: false });
    for (let i = 0; i < 8; i += 1) {
      addBox(0.62, 0.075, 0.64, -5.2 + i * 1.5, 0.038, 18.6, M.lineYellow, { cast: false, receive: false });
    }

    // A few concrete bump stops at the back of the north row
    for (let i = 0; i < 12; i += 2) {
      addBox(1.5, 0.14, 0.22, -17.6 + i * 3.2, 0.07, -24.15, M.concrete, { cast: false });
    }
  }

  function buildLamps() {
    addLamp(-27.2, -13.0, 1, true);
    addLamp(27.2, -12.0, -1, true);
    addLamp(-27.2, 10.0, 1, true);
    addLamp(27.2, 16.0, -1, true);
    addLamp(-7.4, 22.6, 1, false);
    addLamp(16.4, 22.6, -1, false);
    addPlanter(-26.4, 22.0);
    addPlanter(25.4, -13.4);
    addPlanter(-26.4, -13.4);
    addPlanter(25.4, 22.0);
  }

  function buildDeck() {
    createBays();

    // Concrete slab with an asphalt driving surface
    addBox(62, 0.62, 54, 0, -0.31, -1, M.concreteDark, { cast: false });
    addBox(60.6, 0.06, 52.2, 0, -0.03, -1, M.asphalt, { cast: false });

    // Structural beams glimpsed over the parapet
    for (let i = 0; i < 9; i += 1) {
      addBox(0.42, 0.34, 54, -27 + i * 6.8, -0.2, -1, M.concrete, { cast: false, receive: false });
    }

    buildDeckPerimeter();
    buildParkingLines();
    buildLamps();
    buildCanopy();
    buildSignage();
    buildDeckDetails();

    // Entrance gate frame on the south wall (decorative)
    addBox(0.42, 4.6, 0.42, -4.2, 2.3, 24.4, M.steel);
    addBox(0.42, 4.6, 0.42, 4.2, 2.3, 24.4, M.steel);
    addBox(9.4, 0.32, 0.5, 0, 4.67, 24.4, M.darkMetal);
    addStaticCollider(-4.2, 24.4, 0.34, 0.34, 'gate');
    addStaticCollider(4.2, 24.4, 0.34, 0.34, 'gate');
    const gateGlow = new THREE.MeshBasicMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.55 });
    addBox(8.9, 0.04, 0.06, 0, 4.5, 24.4, gateGlow, { cast: false, receive: false });
  }

  /* --------------------------------------------------------------------------
     Vehicle construction
     -------------------------------------------------------------------------- */
  const CAR = {
    body: null,
    paint: null,
    wheels: [],
    frontPivots: [],
    wheelSpin: 0,
    steeringWheel: null,
    headlights: [],
    tailLights: [],
    brakeGlow: null,
    spotlight: null,
    contact: null,
    rollGroup: null,
    interior: null
  };

  function createExtrudedProfile(points, depth, material, bevel) {
    const shape = new THREE.Shape();
    shape.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) shape.lineTo(points[i][0], points[i][1]);
    shape.closePath();
    const geometry = new THREE.ExtrudeGeometry(shape, {
      depth: depth,
      bevelEnabled: true,
      bevelSegments: 2,
      steps: 1,
      bevelSize: bevel === undefined ? 0.035 : bevel,
      bevelThickness: bevel === undefined ? 0.035 : bevel,
      curveSegments: 6
    });
    geometry.translate(0, 0, -depth / 2);
    geometry.rotateY(Math.PI / 2);
    geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, material);
  }

  function createGlowSpriteLocal(parent, color, x, y, z, scale, opacity) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: makeGlowTexture(),
      color: color,
      transparent: true,
      opacity: opacity === undefined ? 0.7 : opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false
    }));
    sprite.position.set(x, y, z);
    sprite.scale.set(scale, scale, 1);
    parent.add(sprite);
    return sprite;
  }

  function buildWheel(radius, width, side) {
    const wheel = new THREE.Group();

    const tire = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, width, 20, 1), M.rubber);
    tire.rotation.z = PI / 2;
    tire.castShadow = true;
    wheel.add(tire);

    const rim = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.66, radius * 0.66, width + 0.008, 18, 1),
      M.rimGold
    );
    rim.rotation.z = PI / 2;
    wheel.add(rim);

    const barrel = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.46, radius * 0.46, width + 0.014, 16, 1),
      M.darkMetal
    );
    barrel.rotation.z = PI / 2;
    wheel.add(barrel);

    const hub = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.15, radius * 0.15, width + 0.03, 10), M.rimGold);
    hub.rotation.z = PI / 2;
    wheel.add(hub);

    // Five spokes on the visible outer face
    const spokes = new THREE.Group();
    spokes.position.x = side * width * 0.52;
    for (let i = 0; i < 5; i += 1) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.035, radius * 1.18, 0.075), M.rimGold);
      spoke.rotation.x = (i / 5) * TAU;
      spoke.position.y = radius * 0.5;
      spoke.position.z = 0;
      // Rotate the offset along with the spoke so the spokes radiate from the centre
      const angle = (i / 5) * TAU;
      spoke.position.y = Math.cos(angle) * radius * 0.5;
      spoke.position.z = Math.sin(angle) * radius * 0.5;
      spoke.rotation.x = -angle;
      spokes.add(spoke);
    }
    wheel.add(spokes);

    const disc = new THREE.Mesh(
      new THREE.CylinderGeometry(radius * 0.42, radius * 0.42, 0.018, 16),
      new THREE.MeshStandardMaterial({ color: 0x6d747b, roughness: 0.42, metalness: 0.86 })
    );
    disc.rotation.z = PI / 2;
    disc.position.x = -side * width * 0.32;
    wheel.add(disc);

    const caliper = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.16, 0.09), M.rimGold);
    caliper.position.set(-side * width * 0.36, 0.02, -radius * 0.31);
    wheel.add(caliper);

    return wheel;
  }

  function buildPlayerCar() {
    const paint = new THREE.MeshStandardMaterial({
      color: 0xefece4,
      metalness: 0.62,
      roughness: 0.2
    });
    const carbon = new THREE.MeshStandardMaterial({
      color: 0x14181d,
      metalness: 0.56,
      roughness: 0.4
    });
    const glass = new THREE.MeshStandardMaterial({
      color: 0x0a1a26,
      metalness: 0.92,
      roughness: 0.06,
      transparent: true,
      opacity: 0.92
    });
    const chrome = new THREE.MeshStandardMaterial({
      color: 0xd7dee4,
      metalness: 0.98,
      roughness: 0.12
    });
    const headMat = new THREE.MeshStandardMaterial({
      color: 0xeaf9ff,
      emissive: 0xd6f1ff,
      emissiveIntensity: 2.4,
      metalness: 0.2,
      roughness: 0.16
    });
    const tailMat = new THREE.MeshStandardMaterial({
      color: 0xff2a20,
      emissive: 0xff1a10,
      emissiveIntensity: 1.9,
      roughness: 0.28
    });
    const trimGold = M.rimGold;

    const root = new THREE.Group();
    const bodyGroup = new THREE.Group();
    root.add(bodyGroup);
    CAR.rollGroup = bodyGroup;
    CAR.paint = paint;

    const body = createExtrudedProfile([
      [2.04, 0.3], [2.13, 0.44], [2.06, 0.61], [1.56, 0.71],
      [0.92, 0.79], [0.28, 0.84], [-1.32, 0.84], [-1.8, 0.78],
      [-2.04, 0.62], [-2.11, 0.44], [-2.0, 0.28], [-1.5, 0.23], [1.5, 0.23]
    ], 1.88, paint);
    body.castShadow = true;
    body.receiveShadow = true;
    bodyGroup.add(body);

    const skirt = createExtrudedProfile([
      [2.1, 0.13], [2.19, 0.2], [2.12, 0.3], [-2.15, 0.3],
      [-2.19, 0.19], [-2.1, 0.11], [-1.55, 0.09], [1.55, 0.09]
    ], 1.97, carbon, 0.02);
    bodyGroup.add(skirt);

    const cabin = createExtrudedProfile([
      [0.66, 0.81], [0.34, 1.08], [-0.6, 1.24], [-1.06, 1.14],
      [-1.42, 0.82], [-1.16, 0.79], [0.3, 0.8]
    ], 1.55, glass, 0.02);
    cabin.castShadow = true;
    bodyGroup.add(cabin);

    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.32, 0.055, 0.94), carbon);
    roof.position.set(0, 1.235, 0.22);
    roof.castShadow = true;
    bodyGroup.add(roof);

    const roofStripe = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.02, 0.9), trimGold);
    roofStripe.position.set(0, 1.268, 0.22);
    bodyGroup.add(roofStripe);

    // Hood vents and bonnet line
    [-1, 1].forEach((side) => {
      const vent = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.018, 0.56), carbon);
      vent.position.set(side * 0.38, 0.842, -1.16);
      bodyGroup.add(vent);

      const ventSlat = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.02, 0.02), trimGold);
      ventSlat.position.set(side * 0.38, 0.853, -1.3);
      bodyGroup.add(ventSlat);
    });

    const splitter = new THREE.Mesh(new THREE.BoxGeometry(1.98, 0.055, 0.38), carbon);
    splitter.position.set(0, 0.13, -2.04);
    splitter.castShadow = true;
    bodyGroup.add(splitter);

    const diffuser = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.14, 0.34), carbon);
    diffuser.position.set(0, 0.18, 2.03);
    bodyGroup.add(diffuser);

    const spoiler = new THREE.Mesh(new THREE.BoxGeometry(1.52, 0.055, 0.4), carbon);
    spoiler.position.set(0, 1.01, 1.89);
    spoiler.rotation.x = -0.035;
    spoiler.castShadow = true;
    bodyGroup.add(spoiler);

    [-1, 1].forEach((side) => {
      const stanchion = new THREE.Mesh(new THREE.BoxGeometry(0.055, 0.2, 0.12), carbon);
      stanchion.position.set(side * 0.62, 0.9, 1.92);
      bodyGroup.add(stanchion);

      const sideSkirt = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 2.36), carbon);
      sideSkirt.position.set(side * 1.005, 0.24, 0.02);
      bodyGroup.add(sideSkirt);

      const goldSill = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.03, 2.3), trimGold);
      goldSill.position.set(side * 1.045, 0.235, 0.02);
      bodyGroup.add(goldSill);

      const mirrorStem = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.045, 0.07), carbon);
      mirrorStem.position.set(side * 0.95, 0.875, -0.47);
      bodyGroup.add(mirrorStem);

      const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.09, 0.14), paint);
      mirror.position.set(side * 1.07, 0.9, -0.47);
      mirror.rotation.z = side * 0.07;
      bodyGroup.add(mirror);

      const mirrorGlass = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.06), chrome);
      mirrorGlass.position.set(side * 1.2, 0.9, -0.47);
      mirrorGlass.rotation.y = side * PI / 2;
      bodyGroup.add(mirrorGlass);

      const vent = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.14, 0.36), carbon);
      vent.position.set(side * 0.94, 0.62, 0.66);
      bodyGroup.add(vent);

      const headlight = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.1, 0.1), headMat);
      headlight.position.set(side * 0.58, 0.61, -2.06);
      headlight.rotation.x = -0.16;
      bodyGroup.add(headlight);

      const drl = new THREE.Mesh(new THREE.BoxGeometry(0.36, 0.025, 0.02), headMat);
      drl.position.set(side * 0.59, 0.68, -2.12);
      bodyGroup.add(drl);

      createGlowSpriteLocal(bodyGroup, 0xfff0cf, side * 0.58, 0.62, -2.17, 0.9, 0.55);

      const tail = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.09, 0.07), tailMat);
      tail.position.set(side * 0.54, 0.68, 2.06);
      bodyGroup.add(tail);
      CAR.tailLights.push(tail);

      const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.16, 12), chrome);
      exhaust.rotation.x = PI / 2;
      exhaust.position.set(side * 0.42, 0.26, 2.11);
      bodyGroup.add(exhaust);
    });

    const tailBar = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.055, 0.06), tailMat);
    tailBar.position.set(0, 0.735, 2.055);
    bodyGroup.add(tailBar);
    CAR.tailLights.push(tailBar);
    CAR.tailMaterial = tailMat;
    CAR.brakeGlow = createGlowSpriteLocal(bodyGroup, 0xff2c1e, 0, 0.7, 2.2, 1.5, 0.26);

    const frontGrille = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.15, 0.07), carbon);
    frontGrille.position.set(0, 0.4, -2.14);
    bodyGroup.add(frontGrille);

    const badge = new THREE.Mesh(new THREE.CircleGeometry(0.07, 20), trimGold);
    badge.position.set(0, 0.55, -2.15);
    badge.rotation.y = PI;
    bodyGroup.add(badge);

    // Wheel-arch trims hide the body/wheel intersection
    [-1, 1].forEach((side) => {
      [-1.41, 1.41].forEach((z) => {
        const arch = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.045, 6, 18, PI), carbon);
        arch.position.set(side * 0.945, 0.38, z);
        arch.rotation.y = side * PI / 2;
        arch.rotation.z = 0;
        bodyGroup.add(arch);
      });
    });

    // License plates
    const plateTexture = makeTextDecal('APEX 3D', {
      width: 256,
      height: 72,
      fontSize: 34,
      color: '#f1c37a',
      background: '#0b1117',
      letterSpacing: 3
    });
    const plateMat = new THREE.MeshBasicMaterial({ map: plateTexture });
    const rearPlate = new THREE.Mesh(new THREE.PlaneGeometry(0.46, 0.13), plateMat);
    rearPlate.position.set(0, 0.45, 2.17);
    bodyGroup.add(rearPlate);

    // Headlight beam
    const beam = new THREE.SpotLight(0xfff0d0, 1.5, 28, PI / 7, 0.62, 1.4);
    beam.position.set(0, 0.72, -1.9);
    const beamTarget = new THREE.Object3D();
    beamTarget.position.set(0, 0.02, -15);
    root.add(beamTarget);
    beam.target = beamTarget;
    beam.castShadow = false;
    root.add(beam);
    CAR.spotlight = beam;

    // Interior: dashboard, seats, console and steering wheel
    const interior = new THREE.Group();
    const dash = new THREE.Mesh(new THREE.BoxGeometry(1.54, 0.18, 0.34), carbon);
    dash.position.set(0, 0.85, -0.62);
    interior.add(dash);
    const dashTop = new THREE.Mesh(new THREE.BoxGeometry(1.42, 0.06, 0.2), new THREE.MeshStandardMaterial({
      color: 0x20262d,
      roughness: 0.72,
      metalness: 0.18
    }));
    dashTop.position.set(0, 0.95, -0.66);
    interior.add(dashTop);

    const clusterScreen = new THREE.Mesh(
      new THREE.PlaneGeometry(0.44, 0.14),
      new THREE.MeshBasicMaterial({ color: 0x1d3a4f })
    );
    clusterScreen.position.set(-0.34, 0.96, -0.76);
    clusterScreen.rotation.x = -0.24;
    interior.add(clusterScreen);

    const consoleBox = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.1, 1.0), carbon);
    consoleBox.position.set(0.02, 0.66, -0.05);
    interior.add(consoleBox);

    const seatMat = new THREE.MeshStandardMaterial({ color: 0x22272d, roughness: 0.82, metalness: 0.04 });
    [-0.38, 0.38].forEach((x) => {
      const seat = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.14, 0.5), seatMat);
      seat.position.set(x, 0.66, 0.28);
      interior.add(seat);
      const back = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.62, 0.14), seatMat);
      back.position.set(x, 0.95, 0.56);
      back.rotation.x = -0.12;
      interior.add(back);
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.16, 0.12), seatMat);
      head.position.set(x, 1.28, 0.62);
      interior.add(head);
      const belt = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.62, 0.03), new THREE.MeshStandardMaterial({
        color: 0x9d3b2e,
        roughness: 0.8
      }));
      belt.position.set(x - 0.16, 0.93, 0.47);
      belt.rotation.x = -0.12;
      interior.add(belt);
    });

    const wheelGroup = new THREE.Group();
    const steeringRim = new THREE.Mesh(new THREE.TorusGeometry(0.145, 0.022, 8, 26), seatMat);
    wheelGroup.add(steeringRim);
    for (let i = 0; i < 3; i += 1) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.13, 0.024), M.rimGold);
      spoke.position.y = 0.075;
      spoke.rotation.z = (i / 3) * TAU + PI / 2;
      const angle = (i / 3) * TAU + PI / 2;
      spoke.position.x = Math.cos(angle) * 0.075;
      spoke.position.y = Math.sin(angle) * 0.075;
      spoke.rotation.z = angle - PI / 2;
      wheelGroup.add(spoke);
    }
    const hubCap = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 12), M.rimGold);
    hubCap.rotation.x = PI / 2;
    wheelGroup.add(hubCap);
    wheelGroup.position.set(-0.36, 0.97, -0.5);
    wheelGroup.rotation.x = -0.22;
    interior.add(wheelGroup);
    CAR.steeringWheel = wheelGroup;

    const column = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.26, 8), carbon);
    column.position.set(-0.36, 0.92, -0.62);
    column.rotation.x = PI / 2.35;
    interior.add(column);

    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.075, 0.03), carbon);
    mirror.position.set(0, 1.22, -0.46);
    interior.add(mirror);

    bodyGroup.add(interior);
    CAR.interior = interior;

    // Wheels and front steering pivots
    const wheelRadius = 0.37;
    const wheelPositions = [
      [-0.95, -1.41, true],
      [0.95, -1.41, true],
      [-0.95, 1.41, false],
      [0.95, 1.41, false]
    ];
    wheelPositions.forEach((entry) => {
      const pivot = new THREE.Group();
      pivot.position.set(entry[0], wheelRadius, entry[1]);
      const wheel = buildWheel(wheelRadius, 0.34, entry[0] < 0 ? -1 : 1);
      pivot.add(wheel);
      root.add(pivot);
      CAR.wheels.push(wheel);
      if (entry[2]) CAR.frontPivots.push(pivot);
    });

    // Grounding shadow
    const contact = new THREE.Mesh(
      new THREE.PlaneGeometry(2.85, 5.2),
      new THREE.MeshBasicMaterial({
        map: makeContactTexture(),
        transparent: true,
        opacity: 0.72,
        depthWrite: false
      })
    );
    contact.rotation.x = -PI / 2;
    contact.position.y = 0.014;
    contact.renderOrder = 1;
    root.add(contact);
    CAR.contact = contact;

    root.traverse((child) => {
      if (child.isMesh && child.material !== contact.material) {
        child.castShadow = child.castShadow || false;
        child.receiveShadow = false;
      }
    });
    root.traverse((child) => {
      if (child.isMesh) child.castShadow = true;
    });
    // Contact shadow and emissive glass should not cast shadows
    contact.castShadow = false;

    root.position.set(0, 0, 0);
    scene.add(root);
    CAR.body = root;
    return root;
  }

  /* --------------------------------------------------------------------------
     Parked traffic — shared geometry, cached paint materials
     -------------------------------------------------------------------------- */
  const parkedPaintCache = {};
  let parkedBodyGeo = null;
  let parkedCabinGeo = null;
  let parkedSkirtGeo = null;

  const PARKED_COLORS = [0x2f6f9e, 0x9b2f34, 0x2c3b45, 0xc9ccd2, 0x233a52, 0x7c6a52, 0x394c3f, 0x8e4a2a, 0x1e2b36, 0xb0a695];

  function parkedPaint(hex) {
    if (!parkedPaintCache[hex]) {
      parkedPaintCache[hex] = new THREE.MeshStandardMaterial({
        color: hex,
        metalness: 0.5,
        roughness: 0.32
      });
    }
    return parkedPaintCache[hex];
  }

  function buildParkedCar(colorHex, scale) {
    if (!parkedBodyGeo) {
      const bodyMesh = createExtrudedProfile([
        [1.98, 0.3], [2.06, 0.44], [1.99, 0.6], [1.5, 0.7],
        [0.86, 0.79], [0.24, 0.84], [-1.34, 0.84], [-1.82, 0.78],
        [-2.02, 0.62], [-2.08, 0.44], [-1.98, 0.28], [-1.5, 0.23], [1.5, 0.23]
      ], 1.84, parkedPaint(0xffffff));
      parkedBodyGeo = bodyMesh.geometry;
      const cabinMesh = createExtrudedProfile([
        [0.6, 0.81], [0.3, 1.08], [-0.62, 1.22], [-1.02, 1.11],
        [-1.36, 0.82], [-1.1, 0.79], [0.28, 0.8]
      ], 1.5, parkedPaint(0xffffff));
      parkedCabinGeo = cabinMesh.geometry;
    }
    const s = scale || 1;
    const group = new THREE.Group();
    const paint = parkedPaint(colorHex);

    const body = new THREE.Mesh(parkedBodyGeo, paint);
    body.castShadow = true;
    body.receiveShadow = true;
    group.add(body);

    const cabin = new THREE.Mesh(
      parkedCabinGeo,
      new THREE.MeshStandardMaterial({ color: 0x0c1a24, metalness: 0.9, roughness: 0.08 })
    );
    cabin.castShadow = true;
    group.add(cabin);

    const roof = new THREE.Mesh(new THREE.BoxGeometry(1.24, 0.05, 0.9), paint);
    roof.position.set(0, 1.22, 0.2);
    group.add(roof);

    const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.3, 14, 1);
    const rimGeo = new THREE.CylinderGeometry(0.19, 0.19, 0.31, 12, 1);
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x9aa1a7, metalness: 0.82, roughness: 0.32 });
    [[-0.92, -1.38], [0.92, -1.38], [-0.92, 1.38], [0.92, 1.38]].forEach((p) => {
      const tire = new THREE.Mesh(wheelGeo, M.rubber);
      tire.rotation.z = PI / 2;
      tire.position.set(p[0], 0.34, p[1]);
      tire.castShadow = true;
      group.add(tire);
      const rim = new THREE.Mesh(rimGeo, rimMat);
      rim.rotation.z = PI / 2;
      rim.position.set(p[0], 0.34, p[1]);
      group.add(rim);
    });

    const tail = new THREE.Mesh(
      new THREE.BoxGeometry(1.3, 0.055, 0.05),
      new THREE.MeshStandardMaterial({ color: 0x7e1614, emissive: 0x5c0d0a, emissiveIntensity: 0.5, roughness: 0.4 })
    );
    tail.position.set(0, 0.66, 2.03);
    group.add(tail);

    const plate = new THREE.Mesh(
      new THREE.PlaneGeometry(0.4, 0.12),
      new THREE.MeshBasicMaterial({ color: 0xcfd6da })
    );
    plate.position.set(0, 0.45, 2.09);
    group.add(plate);

    group.scale.setScalar(s);
    return group;
  }

  /* --------------------------------------------------------------------------
     Cones and concrete barriers
     -------------------------------------------------------------------------- */
  const coneGeo = new THREE.ConeGeometry(0.2, 0.58, 12, 1, true);
  const coneBaseGeo = new THREE.BoxGeometry(0.42, 0.045, 0.42);
  const coneBandGeo = new THREE.CylinderGeometry(0.135, 0.165, 0.11, 12, 1, true);
  const coneMat = new THREE.MeshStandardMaterial({ color: 0xe4621c, roughness: 0.62, metalness: 0.02 });
  const coneBandMat = new THREE.MeshStandardMaterial({ color: 0xf3ede0, roughness: 0.5, metalness: 0.02 });

  function buildCone(x, z) {
    const group = new THREE.Group();
    const base = new THREE.Mesh(coneBaseGeo, coneMat);
    base.position.y = 0.023;
    base.castShadow = true;
    group.add(base);
    const cone = new THREE.Mesh(coneGeo, coneMat);
    cone.position.y = 0.32;
    cone.castShadow = true;
    group.add(cone);
    const band = new THREE.Mesh(coneBandGeo, coneBandMat);
    band.position.y = 0.35;
    band.castShadow = true;
    group.add(band);
    group.position.set(x, 0, z);
    group.userData.cone = true;
    return group;
  }

  const barrierConcrete = new THREE.MeshStandardMaterial({ color: 0x9da3a2, roughness: 0.9, metalness: 0.04 });
  const barrierStripe = new THREE.MeshStandardMaterial({ color: 0xe0b455, roughness: 0.55, metalness: 0.1 });

  function buildBarrier(x, z, yaw) {
    const group = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.26, 0.62), barrierConcrete);
    base.position.y = 0.13;
    base.castShadow = true;
    base.receiveShadow = true;
    group.add(base);
    const top = new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.5, 0.34), barrierConcrete);
    top.position.y = 0.5;
    top.castShadow = true;
    group.add(top);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.05, 0.14, 0.36), barrierStripe);
    stripe.position.y = 0.5;
    group.add(stripe);
    const footGeo = new THREE.BoxGeometry(0.2, 0.12, 0.7);
    [-0.95, 0.95].forEach((fx) => {
      const foot = new THREE.Mesh(footGeo, M.darkMetal);
      foot.position.set(fx, 0.06, 0);
      group.add(foot);
    });
    group.position.set(x, 0, z);
    group.rotation.y = yaw || 0;
    return group;
  }

  /* --------------------------------------------------------------------------
     Missions
     -------------------------------------------------------------------------- */
  const LEVELS = [
    {
      name: 'FIRST ARRIVAL',
      desc: 'Pull into the illuminated bay and stop cleanly between the lines.',
      tip: 'The wheel returns to centre automatically. Feather the gas, then let the car settle.',
      target: { row: 'north', index: 3 },
      start: { x: 0, z: 4.5, yaw: 0 },
      gear: 'D',
      par: 40,
      difficulty: 1,
      occupied: { north: [0, 1, 5, 8, 11], south: [1, 4, 7] },
      cones: [],
      barriers: []
    },
    {
      name: 'NARROW APPROACH',
      desc: 'Thread the deck traffic and slot into bay A-08 without a scratch.',
      tip: 'Tap the camera button for a wider view. Short throttle bursts keep the nose tidy.',
      target: { row: 'north', index: 7 },
      start: { x: -18, z: 6.5, yaw: 0 },
      gear: 'D',
      par: 50,
      difficulty: 1,
      occupied: { north: [4, 5, 8, 11], south: [2, 5, 8] },
      cones: [{ x: -3.6, z: -10.4 }, { x: 2.4, z: -12.2 }, { x: 15.6, z: -6.4 }],
      barriers: []
    },
    {
      name: 'REVERSE BAY',
      desc: 'Shift into R and back into bay B-08. Straight line, gentle feet.',
      tip: 'The selector starts in R. Ease on the gas to reverse, and let the car roll to a stop.',
      target: { row: 'south', index: 7 },
      start: { x: 8, z: 2.6, yaw: 0 },
      gear: 'R',
      par: 55,
      difficulty: 2,
      occupied: { north: [0, 3, 6, 9], south: [4, 5, 9] },
      cones: [{ x: 5.5, z: 6.6 }, { x: 10.5, z: 6.6 }],
      barriers: []
    },
    {
      name: 'CROWDED DECK',
      desc: 'A busy evening on the deck. Weave through the row and claim A-10.',
      tip: 'Watch the parked cars on both sides. A wide entry arc beats a tight correction.',
      target: { row: 'north', index: 9 },
      start: { x: 22, z: 20, yaw: 0.1 },
      gear: 'D',
      par: 60,
      difficulty: 2,
      occupied: { north: [6, 7, 10, 11], south: [1, 6, 8] },
      cones: [{ x: -4.5, z: 4.2 }, { x: 1.5, z: 1.4 }, { x: 8.5, z: -2.6 }],
      barriers: []
    },
    {
      name: 'CONE CORRIDOR',
      desc: 'The valet crew left a cone gate. Line up A-05 and squeeze through.',
      tip: 'Cones knock over when clipped, but every contact costs you stars. Aim for the middle.',
      target: { row: 'north', index: 4 },
      start: { x: 0, z: 19, yaw: 0 },
      gear: 'D',
      par: 65,
      difficulty: 2,
      occupied: { north: [2, 3, 5, 7], south: [3, 5, 8] },
      cones: [
        { x: -8, z: -14 }, { x: -6.4, z: -14.2 }, { x: -3, z: -14 }, { x: -1.4, z: -14.2 },
        { x: 8, z: 6.6 }, { x: 12, z: 9.4 }
      ],
      barriers: []
    },
    {
      name: 'VIP CANOPY',
      desc: 'Deliver the pearl coupe to the lit VIP bay under the canopy.',
      tip: 'The canopy pillars are solid. Keep them in your mirrors as you turn in.',
      target: { row: 'north', index: 2 },
      start: { x: 12, z: 5.5, yaw: 0 },
      gear: 'D',
      par: 55,
      difficulty: 3,
      occupied: { north: [0, 4, 7, 10], south: [0, 4, 9] },
      cones: [{ x: -6.2, z: -12.2 }, { x: -16.2, z: -12.2 }, { x: 2.4, z: -7.4 }],
      barriers: []
    },
    {
      name: 'PARALLEL PRECISION',
      desc: 'Pull past the curb space, then reverse in beside the glass rail.',
      tip: 'Switch to the TOP camera. Stop alongside the space, then reverse with a shallow arc.',
      target: { row: 'parallel', index: 0 },
      start: { x: 22.2, z: 13.5, yaw: 0 },
      gear: 'D',
      par: 75,
      difficulty: 3,
      occupied: { north: [8, 9, 10, 11], south: [7, 8, 9] },
      cones: [{ x: 23.2, z: -8.6 }, { x: 20.4, z: 8.8 }],
      barriers: [
        { x: 28.4, z: 8.4, yaw: PI / 2 },
        { x: 28.4, z: -4.2, yaw: PI / 2 }
      ]
    },
    {
      name: 'FINAL VALET',
      desc: 'One bay left between two cars. The captain is watching.',
      tip: 'Top camera, tiny corrections, and stop completely. This is the shift that matters.',
      target: { row: 'north', index: 1 },
      start: { x: 23, z: -2, yaw: 0 },
      gear: 'D',
      par: 85,
      difficulty: 3,
      occupied: {
        north: [0, 2, 3, 5, 6, 8, 9, 10, 11],
        south: [0, 1, 4, 6, 8, 9]
      },
      cones: [
        { x: -8.2, z: -9.6 }, { x: -10.4, z: -8.2 },
        { x: -18.4, z: -8.4 }, { x: -20.2, z: -7.2 }
      ],
      barriers: [
        { x: 8.4, z: -10.6, yaw: 0 },
        { x: -2.2, z: 3.4, yaw: 0 },
        { x: 14.6, z: 7.2, yaw: 0 }
      ]
    }
  ];

  const levelColliders = [];
  let levelCones = [];
  let levelProps = null;
  let targetMarker = null;
  let targetBay = null;
  let targetLight = null;
  let targetMaterials = null;

  function resolveBay(ref) {
    if (ref.row === 'parallel') return bays.parallel;
    return ref.row === 'north' ? bays.north[ref.index] : bays.south[ref.index];
  }

  function clearLevelProps() {
    if (levelProps) {
      scene.remove(levelProps);
      levelProps.traverse((child) => {
        if (child.isMesh && child.userData.disposable) {
          if (child.geometry) child.geometry.dispose();
          if (child.material) child.material.dispose();
        }
      });
    }
    levelProps = new THREE.Group();
    scene.add(levelProps);
    levelCones = [];
    levelColliders.length = 0;
  }

  function createTargetMarker() {
    targetMaterials = {
      fill: new THREE.MeshBasicMaterial({
        map: makeGlowTexture(),
        color: 0xf2b24c,
        transparent: true,
        opacity: 0.3,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      }),
      edge: new THREE.MeshBasicMaterial({ color: 0xffc870, transparent: true, opacity: 0.95 }),
      beacon: new THREE.MeshBasicMaterial({ color: 0xffd28a, transparent: true, opacity: 0.85 })
    };
    const group = new THREE.Group();

    const fill = new THREE.Mesh(G.plane, targetMaterials.fill);
    fill.rotation.x = -PI / 2;
    fill.position.y = 0.035;
    fill.renderOrder = 3;
    group.add(fill);
    group.userData.fill = fill;

    const edgeGeo = G.box;
    const edges = [];
    for (let i = 0; i < 4; i += 1) {
      const edge = new THREE.Mesh(edgeGeo, targetMaterials.edge);
      edge.position.y = 0.05;
      edge.castShadow = false;
      edge.receiveShadow = false;
      group.add(edge);
      edges.push(edge);
    }
    group.userData.edges = edges;

    const beacons = [];
    for (let i = 0; i < 4; i += 1) {
      const beacon = new THREE.Mesh(G.cylinder, targetMaterials.beacon);
      beacon.scale.set(0.07, 1.15, 0.07);
      beacon.position.y = 0.585;
      group.add(beacon);
      const tip = new THREE.Sprite(new THREE.SpriteMaterial({
        map: makeGlowTexture(),
        color: 0xffc870,
        transparent: true,
        opacity: 0.8,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false
      }));
      tip.position.y = 1.2;
      tip.scale.set(1.1, 1.1, 1);
      group.add(tip);
      beacons.push(beacon);
    }
    group.userData.beacons = beacons;

    const arrow = new THREE.Mesh(
      new THREE.ConeGeometry(0.3, 0.42, 4),
      new THREE.MeshBasicMaterial({ color: 0xffc870, transparent: true, opacity: 0.9 })
    );
    arrow.rotation.x = PI;
    arrow.position.y = 3.0;
    group.add(arrow);
    group.userData.arrow = arrow;

    targetLight = new THREE.PointLight(0xffb968, 0.95, 9, 2);
    targetLight.position.set(0, 2.7, 0);
    group.add(targetLight);

    scene.add(group);
    targetMarker = group;
  }

  function positionTargetMarker() {
    if (!targetMarker || !targetBay) return;
    targetMarker.position.set(targetBay.x, 0, targetBay.z);
    targetMarker.rotation.y = targetBay.yaw || 0;
    const w = targetBay.w - 0.24;
    const d = targetBay.d - 0.24;
    const fill = targetMarker.userData.fill;
    fill.scale.set(w, d, 1);
    const edges = targetMarker.userData.edges;
    const thickness = 0.1;
    const edgeLen = targetBay.parallel ? 0.95 : 0.8;
    // Four L-ish corner bars
    const positions = [
      [-w / 2 + edgeLen / 2, -d / 2, edgeLen, thickness],
      [w / 2 - edgeLen / 2, -d / 2, edgeLen, thickness],
      [-w / 2, d / 2 - edgeLen / 2, thickness, edgeLen],
      [w / 2, d / 2 - edgeLen / 2, thickness, edgeLen]
    ];
    edges.forEach((edge, i) => {
      const p = positions[i];
      edge.scale.set(p[2], 0.035, p[3]);
      edge.position.x = p[0];
      edge.position.z = p[1];
    });
    const beacons = targetMarker.userData.beacons;
    const corners = [
      [-w / 2, -d / 2],
      [w / 2, -d / 2],
      [-w / 2, d / 2],
      [w / 2, d / 2]
    ];
    beacons.forEach((beacon, i) => {
      beacon.position.x = corners[i][0];
      beacon.position.z = corners[i][1];
    });
  }

  function updateTargetMarker(time, valid) {
    if (!targetMarker) return;
    const pulse = 0.5 + Math.sin(time * 3.4) * 0.5;
    const color = valid ? 0x7dffb0 : 0xf2b24c;
    targetMaterials.fill.color.setHex(color);
    targetMaterials.edge.color.setHex(valid ? 0x8bffbc : 0xffc870);
    targetMaterials.beacon.color.setHex(valid ? 0x8bffbc : 0xffd28a);
    targetMaterials.fill.opacity = 0.18 + pulse * 0.18;
    targetMaterials.edge.opacity = 0.62 + pulse * 0.38;
    targetMarker.userData.arrow.position.y = 2.9 + Math.sin(time * 2.2) * 0.18;
    targetMarker.userData.arrow.rotation.y = time * 0.7;
    if (targetLight) targetLight.color.setHex(valid ? 0x7dffb0 : 0xffb968);
  }

  function addParkedCarAt(bay, colorHex) {
    const mesh = buildParkedCar(colorHex, 0.98);
    mesh.position.set(bay.x, 0, bay.z);
    mesh.rotation.y = bay.yaw;
    levelProps.add(mesh);
    levelColliders.push({
      x: bay.x,
      z: bay.z,
      hw: 1.03,
      hd: 2.18,
      tag: 'parked'
    });
  }

  function addConeAt(x, z) {
    const mesh = buildCone(x, z);
    levelProps.add(mesh);
    levelCones.push({
      mesh: mesh,
      x: x,
      z: z,
      homeX: x,
      homeZ: z,
      vx: 0,
      vz: 0,
      tilt: 0,
      tiltAxis: 0,
      spin: 0,
      fallen: false,
      radius: 0.2,
      hit: false
    });
  }

  function buildLevelProps(levelIndex) {
    const def = LEVELS[levelIndex];
    clearLevelProps();

    const northSet = def.occupied.north || [];
    const southSet = def.occupied.south || [];
    let colorIndex = levelIndex;
    northSet.forEach((index) => {
      addParkedCarAt(bays.north[index], PARKED_COLORS[colorIndex++ % PARKED_COLORS.length]);
    });
    southSet.forEach((index) => {
      addParkedCarAt(bays.south[index], PARKED_COLORS[colorIndex++ % PARKED_COLORS.length]);
    });

    (def.cones || []).forEach((cone) => {
      addConeAt(cone.x, cone.z);
    });

    (def.barriers || []).forEach((barrier) => {
      const mesh = buildBarrier(barrier.x, barrier.z, barrier.yaw);
      levelProps.add(mesh);
      const rotated = Math.abs(Math.sin(barrier.yaw || 0)) > 0.5;
      levelColliders.push({
        x: barrier.x,
        z: barrier.z,
        hw: rotated ? 0.38 : 1.18,
        hd: rotated ? 1.18 : 0.38,
        tag: 'barrier'
      });
    });

    targetBay = resolveBay(def.target);
    positionTargetMarker();

    // A subtle spotlight over each parked row keeps the bays readable at night
    updateTargetMarker(state.time, false);
  }

  /* --------------------------------------------------------------------------
     Driving physics
     -------------------------------------------------------------------------- */
  const physics = {
    accumulator: 0,
    step: 1 / 120,
    maxSteps: 8
  };

  function carAxes(yaw) {
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    return {
      rightX: cos,
      rightZ: -sin,
      forwardX: -sin,
      forwardZ: -cos
    };
  }

  function obbVsAabb(cx, cz, yaw, hw, hl, box) {
    const axes = carAxes(yaw);
    const dx = cx - box.x;
    const dz = cz - box.z;
    const testAxes = [
      { x: axes.rightX, z: axes.rightZ, carRadius: hw, boxRadius: Math.abs(axes.rightX) * box.hw + Math.abs(axes.rightZ) * box.hd },
      { x: axes.forwardX, z: axes.forwardZ, carRadius: hl, boxRadius: Math.abs(axes.forwardX) * box.hw + Math.abs(axes.forwardZ) * box.hd },
      { x: 1, z: 0, carRadius: Math.abs(axes.rightX) * hw + Math.abs(axes.forwardX) * hl, boxRadius: box.hw },
      { x: 0, z: 1, carRadius: Math.abs(axes.rightZ) * hw + Math.abs(axes.forwardZ) * hl, boxRadius: box.hd }
    ];
    let best = null;
    for (let i = 0; i < testAxes.length; i += 1) {
      const axis = testAxes[i];
      const distance = Math.abs(dx * axis.x + dz * axis.z);
      const overlap = axis.carRadius + axis.boxRadius - distance;
      if (overlap <= 0) return null;
      if (!best || overlap < best.overlap) {
        const sign = dx * axis.x + dz * axis.z >= 0 ? 1 : -1;
        best = { x: axis.x * sign, z: axis.z * sign, overlap: overlap };
      }
    }
    return best;
  }

  function resolveCarCollisions() {
    let impact = 0;
    for (let iteration = 0; iteration < 3; iteration += 1) {
      let pushed = false;
      for (let i = 0; i < staticColliders.length; i += 1) {
        const c = staticColliders[i];
        const mtv = obbVsAabb(car.x, car.z, car.yaw, CAR_HALF_WIDTH, CAR_HALF_LENGTH, c);
        if (mtv) {
          car.x += mtv.x * (mtv.overlap + 0.002);
          car.z += mtv.z * (mtv.overlap + 0.002);
          impact = Math.max(impact, Math.abs(car.speed));
          pushed = true;
        }
      }
      for (let i = 0; i < levelColliders.length; i += 1) {
        const c = levelColliders[i];
        const mtv = obbVsAabb(car.x, car.z, car.yaw, CAR_HALF_WIDTH, CAR_HALF_LENGTH, c);
        if (mtv) {
          car.x += mtv.x * (mtv.overlap + 0.002);
          car.z += mtv.z * (mtv.overlap + 0.002);
          impact = Math.max(impact, Math.abs(car.speed));
          pushed = true;
        }
      }
      if (!pushed) break;
    }

    // Keep the car on the deck no matter what
    const limitX = LOT.maxX - CAR_HALF_WIDTH;
    const limitZ = LOT.maxZ - CAR_HALF_LENGTH;
    if (car.x < -limitX) { car.x = -limitX; impact = Math.max(impact, Math.abs(car.speed)); }
    if (car.x > limitX) { car.x = limitX; impact = Math.max(impact, Math.abs(car.speed)); }
    if (car.z < -limitZ) { car.z = -limitZ; impact = Math.max(impact, Math.abs(car.speed)); }
    if (car.z > limitZ) { car.z = limitZ; impact = Math.max(impact, Math.abs(car.speed)); }

    return impact;
  }

  function coneHitTest(cone) {
    const axes = carAxes(car.yaw);
    const dx = cone.x - car.x;
    const dz = cone.z - car.z;
    const localX = dx * axes.rightX + dz * axes.rightZ;
    const localZ = dx * axes.forwardX + dz * axes.forwardZ;
    const nearX = clamp(localX, -CAR_HALF_WIDTH, CAR_HALF_WIDTH);
    const nearZ = clamp(localZ, -CAR_HALF_LENGTH, CAR_HALF_LENGTH);
    const gapX = localX - nearX;
    const gapZ = localZ - nearZ;
    return Math.sqrt(gapX * gapX + gapZ * gapZ) <= cone.radius + 0.08;
  }

  function knockCone(cone) {
    if (cone.fallen) return;
    const axes = carAxes(car.yaw);
    const dx = cone.x - car.x;
    const dz = cone.z - car.z;
    const len = Math.max(0.001, Math.sqrt(dx * dx + dz * dz));
    const carVX = axes.forwardX * car.speed;
    const carVZ = axes.forwardZ * car.speed;
    cone.fallen = true;
    cone.tiltAxis = Math.atan2(dx / len, dz / len);
    cone.vx = carVX * 0.42 + (dx / len) * 1.1;
    cone.vz = carVZ * 0.42 + (dz / len) * 1.1;
    cone.spin = (Math.random() - 0.5) * 8;
    if (!cone.hit) {
      cone.hit = true;
      registerContact(1.1);
      showToast('CONE DOWN — EASY ON THE THROTTLE');
    }
  }

  function updateLevelCones(dt) {
    for (let i = 0; i < levelCones.length; i += 1) {
      const cone = levelCones[i];
      if (!cone.fallen) {
        if (coneHitTest(cone)) knockCone(cone);
        continue;
      }
      cone.tilt = damp(cone.tilt, PI / 2, 4.2, dt);
      cone.mesh.rotation.x = Math.sin(cone.tiltAxis) * cone.tilt;
      cone.mesh.rotation.z = Math.cos(cone.tiltAxis) * cone.tilt;
      cone.mesh.rotation.y += cone.spin * dt;
      cone.spin *= Math.exp(-2.2 * dt);
      cone.x += cone.vx * dt;
      cone.z += cone.vz * dt;
      cone.vx *= Math.exp(-2.6 * dt);
      cone.vz *= Math.exp(-2.6 * dt);
      cone.mesh.position.set(cone.x, 0, cone.z);
    }
  }

  function registerContact(intensity) {
    if (state.mode !== 'playing') return;
    if (state.collisionCooldown > 0) return;
    state.collisionCooldown = 0.65;
    state.contacts += 1;
    state.shake = Math.min(1, 0.34 + (intensity || 1) * 0.11);
    audio.hit(Math.min(1, (intensity || 1) / 5));
    flashScreen();
    if ((intensity || 0) > 0.8) showToast('CONTACT — KEEP IT CLEAN');
    updateHudCounters();
  }

  function getParkStatus() {
    if (!targetBay) {
      return { inside: false, aligned: false, stopped: Math.abs(car.speed) < PARK_SPEED_THRESHOLD, valid: false, distance: 0 };
    }
    const bay = targetBay;
    const halfW = bay.w / 2 + 0.4;
    const halfD = bay.d / 2 + 0.4;
    const axes = carAxes(car.yaw);
    const cosB = Math.cos(bay.yaw);
    const sinB = Math.sin(bay.yaw);
    const signs = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
    let inside = true;
    for (let i = 0; i < 4; i += 1) {
      const su = signs[i][0];
      const sv = signs[i][1];
      const px = car.x + axes.rightX * CAR_HALF_WIDTH * su + axes.forwardX * CAR_HALF_LENGTH * sv - bay.x;
      const pz = car.z + axes.rightZ * CAR_HALF_WIDTH * su + axes.forwardZ * CAR_HALF_LENGTH * sv - bay.z;
      const lx = px * cosB - pz * sinB;
      const lz = px * sinB + pz * cosB;
      if (Math.abs(lx) > halfW || Math.abs(lz) > halfD) {
        inside = false;
        break;
      }
    }
    const delta = angleDelta(car.yaw, bay.yaw);
    const aligned = delta <= 0.2 || PI - delta <= 0.2;
    const stopped = Math.abs(car.speed) < PARK_SPEED_THRESHOLD;
    const dx = car.x - bay.x;
    const dz = car.z - bay.z;
    return {
      inside: inside,
      aligned: aligned,
      stopped: stopped,
      valid: inside && aligned && stopped,
      distance: Math.sqrt(dx * dx + dz * dz)
    };
  }

  function updatePhysicsStep(dt) {
    if (!level) return;

    // Steering input with speed-sensitive authority
    let steerTarget = 0;
    if (wheelInput.held) {
      steerTarget = wheelInput.target;
    } else if (input.left && !input.right) {
      steerTarget = -0.9;
    } else if (input.right && !input.left) {
      steerTarget = 0.9;
    }
    const steerSpeed = steerTarget === 0 ? 7.6 : 5.6;
    const previousSpeed = car.speed;
    wheelInput.angle = damp(wheelInput.angle, steerTarget, steerSpeed, dt);
    if (Math.abs(wheelInput.angle) < 0.002) wheelInput.angle = 0;
    car.steer = damp(car.steer, wheelInput.angle, 9.5, dt);

    const absSpeed = Math.abs(car.speed);
    const maxSteer = Math.max(0.2, MAX_STEER_LOW / (1 + absSpeed * 0.115));
    car.wheelAngle = car.steer * maxSteer;

    // Longitudinal forces
    const forwardInput = gear === 'D' ? 1 : gear === 'R' ? -1 : 0;
    let accel = 0;
    if (forwardInput !== 0 && input.gas) {
      if (car.speed * forwardInput < -0.25) {
        accel += forwardInput * 8.2;
      } else {
        accel += forwardInput * (forwardInput > 0 ? 4.4 : 3.1);
      }
    }
    if (input.brake) {
      if (Math.abs(car.speed) > 0.12) accel -= Math.sign(car.speed) * 8.6;
    }
    // Rolling resistance and aero drag
    if (!input.gas) accel -= Math.sign(car.speed) * (1.05 + 0.06 * absSpeed * absSpeed);
    if (input.gas && forwardInput !== 0) accel -= car.speed * 0.035;

    car.speed += accel * dt;

    if (input.brake && previousSpeed !== 0 && Math.sign(previousSpeed) !== Math.sign(car.speed)) {
      car.speed = 0;
    }
    if (!input.gas && Math.abs(car.speed) < 0.06) car.speed = 0;
    car.speed = clamp(car.speed, -MAX_SPEED_REVERSE, MAX_SPEED_FORWARD);
    if (gear === 'N') car.speed *= Math.exp(-0.85 * dt);
    if (Math.abs(car.speed) < 0.015 && !input.gas) car.speed = 0;

    // Yaw from a bicycle model
    const yawRate = -(car.speed / WHEEL_BASE) * Math.tan(car.wheelAngle);
    car.yaw = wrapAngle(car.yaw + yawRate * dt);

    // Integrate position
    const axes = carAxes(car.yaw);
    car.x += axes.forwardX * car.speed * dt;
    car.z += axes.forwardZ * car.speed * dt;

    const impact = resolveCarCollisions();
    if (impact > 0.3) {
      registerContact(impact);
      car.speed = impact > 1.4 ? -car.speed * 0.16 : 0;
    }

    updateLevelCones(dt);

    // Park detection and hold timer
    const status = getParkStatus();
    state.parkStatus = status;
    const holdOk = status.inside && status.aligned && status.stopped;
    if (holdOk) {
      state.parkHold = Math.min(PARK_HOLD_TIME + 0.4, state.parkHold + dt);
      if (state.parkHold >= PARK_HOLD_TIME && state.mode === 'playing') {
        completeLevel();
      }
    } else {
      state.parkHold = Math.max(0, state.parkHold - dt * 1.9);
    }
    state.validPark = status.inside && status.aligned;

    car.wheelSpin += (car.speed / 0.37) * dt;
    if (car.wheelSpin > TAU * 2) car.wheelSpin -= TAU * 2;
    if (car.wheelSpin < -TAU * 2) car.wheelSpin += TAU * 2;

    const rawAccel = (car.speed - previousSpeed) / dt;
    car.accelSmooth = damp(car.accelSmooth, rawAccel, 6, dt);
    const lateral = car.speed * yawRate;
    car.roll = damp(car.roll, clamp(-lateral * 0.012, -0.09, 0.09), 6, dt);
    car.pitch = damp(car.pitch, clamp(car.accelSmooth * 0.008, -0.05, 0.05), 6, dt);

    if (state.collisionCooldown > 0) state.collisionCooldown = Math.max(0, state.collisionCooldown - dt);
  }

  function updatePhysics(dt) {
    physics.accumulator += Math.min(dt, 0.1);
    let steps = 0;
    while (physics.accumulator >= physics.step && steps < physics.maxSteps) {
      updatePhysicsStep(physics.step);
      physics.accumulator -= physics.step;
      steps += 1;
    }
    if (steps === physics.maxSteps) physics.accumulator = 0;
  }

  function resetCarToStart(def) {
    car.x = def.start.x;
    car.z = def.start.z;
    car.yaw = def.start.yaw;
    car.speed = 0;
    car.steer = 0;
    car.wheelAngle = 0;
    car.wheelSpin = 0;
    car.roll = 0;
    car.pitch = 0;
    car.prevSpeed = 0;
    car.accelSmooth = 0;
    wheelInput.angle = 0;
    wheelInput.target = 0;
    wheelInput.held = false;
    wheelInput.pointerId = null;
    physics.accumulator = 0;
    updateCarVisual(0);
  }

  function updateCarVisual(dt) {
    if (!CAR.body) return;
    CAR.body.position.set(car.x, 0, car.z);
    CAR.body.rotation.y = car.yaw;
    if (CAR.rollGroup) {
      CAR.rollGroup.rotation.z = car.roll;
      CAR.rollGroup.rotation.x = car.pitch;
    }
    for (let i = 0; i < CAR.wheels.length; i += 1) {
      CAR.wheels[i].rotation.x = -car.wheelSpin;
    }
    for (let i = 0; i < CAR.frontPivots.length; i += 1) {
      CAR.frontPivots[i].rotation.y = -car.wheelAngle * 1.35;
    }
    if (CAR.steeringWheel) {
      CAR.steeringWheel.rotation.z = -wheelInput.angle * 1.9;
    }
    if (CAR.tailMaterial) {
      const braking = input.brake || (gear === 'D' ? car.speed < -0.3 : car.speed > 0.3);
      CAR.tailMaterial.emissiveIntensity = braking ? 3.4 : 1.45;
    }
    if (CAR.brakeGlow) {
      CAR.brakeGlow.material.opacity = input.brake ? 0.75 : 0.18;
    }
    // Keep the body sitting on its wheels
    const bob = Math.abs(car.speed) > 0.2 ? Math.sin(car.wheelSpin * 2.1) * 0.004 : 0;
    if (CAR.rollGroup) CAR.rollGroup.position.y = bob;
  }

  /* --------------------------------------------------------------------------
     Cameras
     -------------------------------------------------------------------------- */
  const tempVec = new THREE.Vector3();
  const tempLook = new THREE.Vector3();

  function desiredDrivingCamera() {
    const axes = carAxes(car.yaw);
    const mode = CAMERA_MODES[state.cameraMode].id;
    const pose = { pos: new THREE.Vector3(), look: new THREE.Vector3(), fov: 55, snap: false };

    if (mode === 'cockpit') {
      const eyeX = car.x - axes.rightX * 0.36 + axes.forwardX * 0.16;
      const eyeZ = car.z - axes.rightZ * 0.36 + axes.forwardZ * 0.16;
      pose.pos.set(eyeX, 1.06 + car.roll * 0.1, eyeZ);
      const lookAhead = 18;
      const sideLook = wheelInput.angle * 2.4;
      pose.look.set(
        eyeX + axes.forwardX * lookAhead + axes.rightX * sideLook,
        1.02 + car.pitch * 2.4,
        eyeZ + axes.forwardZ * lookAhead + axes.rightZ * sideLook
      );
      pose.fov = 64;
      pose.snap = true;
      return pose;
    }

    if (mode === 'top') {
      const tx = targetBay ? targetBay.x : car.x;
      const tz = targetBay ? targetBay.z : car.z;
      const focusX = car.x + (tx - car.x) * 0.28;
      const focusZ = car.z + (tz - car.z) * 0.28;
      pose.pos.set(focusX, 23, focusZ + 7.5);
      pose.look.set(focusX, 0, focusZ + 0.4);
      pose.fov = 44;
      return pose;
    }

    const close = mode === 'close';
    const distance = close ? 4.9 : 7.8;
    const height = close ? 2.05 : 3.35;
    pose.pos.set(
      car.x - axes.forwardX * distance + axes.rightX * (close ? 0.1 : 0.28),
      height,
      car.z - axes.forwardZ * distance + axes.rightZ * (close ? 0.1 : 0.28)
    );
    pose.look.set(
      car.x + axes.forwardX * (close ? 4.4 : 3.8),
      1.0,
      car.z + axes.forwardZ * (close ? 4.4 : 3.8)
    );
    pose.fov = close ? 58 : 55;
    return pose;
  }

  function menuCameraPose() {
    const t = state.time * 0.11 + 2.15;
    const radius = 8.4;
    const pos = new THREE.Vector3(
      car.x + Math.sin(t) * radius,
      2.9 + Math.sin(state.time * 0.52) * 0.24,
      car.z + Math.cos(t) * radius
    );
    return {
      pos: pos,
      look: new THREE.Vector3(car.x, 0.78, car.z),
      fov: 46
    };
  }

  function updateCamera(dt, snap) {
    if (!camera) return;
    let pose;
    if (state.mode === 'menu' || state.mode === 'levels' || state.mode === 'settings') {
      pose = menuCameraPose();
    } else if (state.mode === 'boot') {
      pose = menuCameraPose();
    } else {
      pose = desiredDrivingCamera();
    }

    const lambda = snap ? 1000 : (pose.snap ? 24 : 5.6);
    camState.pos.x = damp(camState.pos.x, pose.pos.x, lambda, dt);
    camState.pos.y = damp(camState.pos.y, pose.pos.y, lambda, dt);
    camState.pos.z = damp(camState.pos.z, pose.pos.z, lambda, dt);
    camState.look.x = damp(camState.look.x, pose.look.x, snap ? 1000 : 8.2, dt);
    camState.look.y = damp(camState.look.y, pose.look.y, snap ? 1000 : 8.2, dt);
    camState.look.z = damp(camState.look.z, pose.look.z, snap ? 1000 : 8.2, dt);
    camState.fov = damp(camState.fov, pose.fov, snap ? 1000 : 4.2, dt);

    camera.position.copy(camState.pos);
    if (state.shake > 0.001) {
      const s = state.shake;
      camera.position.x += Math.sin(state.time * 73.1) * s * 0.14;
      camera.position.y += Math.cos(state.time * 61.7) * s * 0.1;
      camera.position.z += Math.sin(state.time * 57.3) * s * 0.12;
    }
    camera.fov = camState.fov;
    camera.updateProjectionMatrix();
    camera.lookAt(camState.look);
  }

  function snapCameraToCar() {
    const pose = desiredDrivingCamera();
    camState.pos.copy(pose.pos);
    camState.look.copy(pose.look);
    camState.fov = pose.fov;
    camera.position.copy(pose.pos);
    camera.fov = pose.fov;
    camera.updateProjectionMatrix();
    camera.lookAt(pose.look);
  }

  /* --------------------------------------------------------------------------
     Input
     -------------------------------------------------------------------------- */
  const DIFFICULTY_LABELS = ['', 'EASY', 'MEDIUM', 'HARD'];

  function updateGearButtons() {
    const buttons = document.querySelectorAll('.gear-button');
    for (let i = 0; i < buttons.length; i += 1) {
      const active = buttons[i].getAttribute('data-gear') === gear;
      buttons[i].classList.toggle('is-active', active);
      buttons[i].setAttribute('aria-pressed', active ? 'true' : 'false');
    }
  }

  function setGear(nextGear, silent) {
    if (nextGear !== 'D' && nextGear !== 'N' && nextGear !== 'R') return;
    if (nextGear === gear) {
      updateGearButtons();
      return;
    }
    if (state.mode === 'playing' && (nextGear === 'D' || nextGear === 'R') && Math.abs(car.speed) > 1.25) {
      showToast('SLOW DOWN TO SHIFT');
      updateGearButtons();
      return;
    }
    gear = nextGear;
    car.speed = state.mode === 'playing' ? car.speed : 0;
    updateGearButtons();
    if (!silent) {
      audio.gearShift();
      showToast(gear === 'R' ? 'REVERSE ENGAGED' : gear === 'N' ? 'NEUTRAL' : 'DRIVE ENGAGED', 1100);
    }
  }

  function clearInputs() {
    input.gas = false;
    input.brake = false;
    input.left = false;
    input.right = false;
    wheelInput.held = false;
    wheelInput.pointerId = null;
    wheelInput.target = 0;
    document.querySelectorAll('.pedal.is-pressed, .arrow-input.is-pressed').forEach((el) => el.classList.remove('is-pressed'));
  }

  function bindPedal(el, key) {
    if (!el) return;
    let activePointer = null;

    const press = (event) => {
      if (event.button !== undefined && event.button !== 0 && event.pointerType === 'mouse') return;
      event.preventDefault();
      if (activePointer !== null) return;
      activePointer = event.pointerId;
      audio.unlock();
      input[key] = true;
      el.classList.add('is-pressed');
      try { el.setPointerCapture(event.pointerId); } catch (error) { /* ignore */ }
      if (key === 'gas') showToast('THROTTLE', 700);
    };

    const release = (event) => {
      if (activePointer !== null && event.pointerId !== activePointer) return;
      activePointer = null;
      input[key] = false;
      el.classList.remove('is-pressed');
    };

    el.addEventListener('pointerdown', press);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);
    el.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  function bindArrow(el, side) {
    if (!el) return;
    let activePointer = null;

    const press = (event) => {
      event.preventDefault();
      if (activePointer !== null) return;
      activePointer = event.pointerId;
      audio.unlock();
      input[side] = true;
      el.classList.add('is-pressed');
      try { el.setPointerCapture(event.pointerId); } catch (error) { /* ignore */ }
    };

    const release = (event) => {
      if (activePointer !== null && event.pointerId !== activePointer) return;
      activePointer = null;
      input[side] = false;
      el.classList.remove('is-pressed');
    };

    el.addEventListener('pointerdown', press);
    el.addEventListener('pointerup', release);
    el.addEventListener('pointercancel', release);
    el.addEventListener('lostpointercapture', release);
    el.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  function bindSteeringWheel() {
    const wheel = $('steering-wheel');
    if (!wheel) return;
    let activePointer = null;

    const applyPointer = (event) => {
      const rect = wheel.getBoundingClientRect();
      const center = rect.left + rect.width / 2;
      let nx = clamp((event.clientX - center) / (rect.width * 0.42), -1, 1);
      if (Math.abs(nx) < 0.07) nx = 0;
      const sensitivity = settings.sensitivity / 100;
      wheelInput.target = clamp(nx * sensitivity, -1, 1);
    };

    wheel.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      if (activePointer !== null) return;
      activePointer = event.pointerId;
      audio.unlock();
      wheelInput.held = true;
      wheelInput.pointerId = event.pointerId;
      applyPointer(event);
      wheel.classList.add('is-held');
      try { wheel.setPointerCapture(event.pointerId); } catch (error) { /* ignore */ }
    });

    wheel.addEventListener('pointermove', (event) => {
      if (!wheelInput.held || event.pointerId !== activePointer) return;
      event.preventDefault();
      applyPointer(event);
    });

    const release = (event) => {
      if (activePointer !== null && event.pointerId !== activePointer) return;
      activePointer = null;
      wheelInput.held = false;
      wheelInput.pointerId = null;
      wheelInput.target = 0;
      wheel.classList.remove('is-held');
    };

    wheel.addEventListener('pointerup', release);
    wheel.addEventListener('pointercancel', release);
    wheel.addEventListener('lostpointercapture', release);
    wheel.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  function bindDrivingInputs() {
    bindPedal($('gas-pedal'), 'gas');
    bindPedal($('brake-pedal'), 'brake');
    bindArrow($('arrow-left'), 'left');
    bindArrow($('arrow-right'), 'right');
    bindSteeringWheel();
    updateGearButtons();

    const gears = document.querySelectorAll('.gear-button');
    for (let i = 0; i < gears.length; i += 1) {
      gears[i].addEventListener('click', (event) => {
        event.preventDefault();
        audio.click();
        setGear(gears[i].getAttribute('data-gear'));
      });
    }

    const driveKeyMap = {
      KeyW: 'gas', ArrowUp: 'gas',
      KeyS: 'brake', ArrowDown: 'brake', Space: 'brake',
      KeyA: 'left', ArrowLeft: 'left',
      KeyD: 'right', ArrowRight: 'right'
    };

    window.addEventListener('keydown', (event) => {
      if (event.target && (event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA')) return;
      if (event.code === 'Escape') {
        event.preventDefault();
        handleEscape();
        return;
      }
      if (event.code === 'KeyC') {
        if (state.mode === 'playing') cycleCamera();
        return;
      }
      if (event.code === 'KeyM') {
        toggleSound();
        return;
      }
      if (event.code === 'Digit1') { setGear('D'); return; }
      if (event.code === 'Digit2') { setGear('N'); return; }
      if (event.code === 'Digit3') { setGear('R'); return; }
      const mapped = driveKeyMap[event.code];
      if (mapped) {
        event.preventDefault();
        if (state.mode !== 'playing') return;
        audio.unlock();
        input[mapped] = true;
      }
    });

    window.addEventListener('keyup', (event) => {
      const mapped = driveKeyMap[event.code];
      if (mapped) {
        event.preventDefault();
        input[mapped] = false;
      }
    });

    window.addEventListener('blur', clearInputs);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        clearInputs();
        if (state.mode === 'playing') pauseGame();
      }
    });
  }

  /* --------------------------------------------------------------------------
     UI state machine
     -------------------------------------------------------------------------- */
  const ui = {};
  const UI_IDS = [
    'boot-screen', 'boot-message', 'boot-fill', 'canvas-host',
    'main-menu', 'play-button', 'levels-button', 'menu-settings', 'menu-sound',
    'menu-progress-label', 'menu-progress-fill', 'menu-stars', 'menu-best-time',
    'menu-mission-no', 'menu-mission-name', 'menu-mission-desc', 'menu-difficulty',
    'menu-target-code', 'menu-par-time', 'menu-mission-tip',
    'hud', 'hud-level', 'hud-level-name', 'hud-difficulty', 'hud-timer', 'hud-hits',
    'park-assist', 'assist-arrow', 'assist-distance', 'assist-title', 'check-inside',
    'check-aligned', 'check-stopped', 'hold-ring', 'hold-arc', 'camera-button',
    'camera-label', 'sound-button', 'pause-button', 'toast', 'steering-wheel',
    'wheel-rotor', 'arrow-left', 'arrow-right', 'speed-value', 'speed-arc',
    'gear-selector', 'brake-pedal', 'gas-pedal', 'level-start-card', 'start-level-no',
    'start-difficulty', 'start-level-name', 'start-level-desc',
    'pause-screen', 'resume-button', 'restart-pause', 'settings-pause', 'menu-pause',
    'pause-close', 'pause-level-name', 'pause-time', 'pause-hits',
    'settings-screen', 'settings-close', 'settings-done', 'sound-setting',
    'arrows-setting', 'shake-setting', 'sens-range', 'sens-value', 'quality-control',
    'levels-screen', 'levels-close', 'levels-back', 'level-grid', 'levels-total-stars',
    'complete-screen', 'complete-title', 'complete-sub', 'complete-time', 'complete-hits',
    'complete-stars', 'complete-score', 'complete-award', 'complete-star-count',
    'next-level', 'retry-button', 'complete-levels', 'complete-menu',
    'rotate-note', 'fx-flash', 'selftest-results'
  ];

  let settingsReturn = 'menu';
  let selectedShotTaken = false;

  function cacheUI() {
    UI_IDS.forEach((id) => {
      ui[id] = $(id);
    });
  }

  function padNo(n) {
    return String(n).padStart(2, '0');
  }

  function formatPar(seconds) {
    const s = Math.max(0, Math.round(seconds));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function difficultyLabel(value) {
    return DIFFICULTY_LABELS[value] || 'MEDIUM';
  }

  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((el) => {
      const active = el.id === id;
      el.classList.toggle('is-visible', active);
      el.setAttribute('aria-hidden', active ? 'false' : 'true');
    });
  }

  function hideScreens() {
    document.querySelectorAll('.screen').forEach((el) => {
      el.classList.remove('is-visible');
      el.setAttribute('aria-hidden', 'true');
    });
  }

  function setHudActive(active) {
    if (!ui.hud) return;
    ui.hud.classList.toggle('is-active', active);
    ui.hud.setAttribute('aria-hidden', active ? 'false' : 'true');
  }

  function totalStars() {
    let sum = 0;
    Object.keys(save.stars).forEach((key) => {
      sum += Number(save.stars[key]) || 0;
    });
    return sum;
  }

  function bestOverall() {
    let best = Infinity;
    Object.keys(save.bestTimes).forEach((key) => {
      const value = Number(save.bestTimes[key]);
      if (Number.isFinite(value) && value > 0) best = Math.min(best, value);
    });
    return best;
  }

  function completedCount() {
    let count = 0;
    for (let i = 0; i < LEVELS.length; i += 1) {
      if ((save.stars[i] || 0) > 0) count += 1;
    }
    return count;
  }

  function showToast(message, duration) {
    if (!ui.toast) return;
    ui.toast.textContent = message;
    ui.toast.classList.add('is-visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      ui.toast.classList.remove('is-visible');
    }, duration || 1750);
  }

  let flashTimeout = 0;
  function flashScreen() {
    if (!ui['fx-flash']) return;
    ui['fx-flash'].classList.add('is-hit');
    clearTimeout(flashTimeout);
    flashTimeout = setTimeout(() => ui['fx-flash'].classList.remove('is-hit'), 90);
  }

  function refreshMenu() {
    const nextIndex = clamp(save.unlocked - 1, 0, LEVELS.length - 1);
    const def = LEVELS[nextIndex];
    const bay = resolveBay(def.target);
    const completed = completedCount();
    const stars = totalStars();
    const best = bestOverall();

    ui['menu-progress-label'].textContent = `${completed} / ${LEVELS.length}`;
    if (ui['menu-progress-fill']) ui['menu-progress-fill'].style.width = `${(completed / LEVELS.length) * 100}%`;
    ui['menu-stars'].textContent = String(stars);
    ui['menu-best-time'].textContent = formatTimeLong(best);

    ui['menu-mission-no'].textContent = padNo(nextIndex + 1);
    ui['menu-mission-name'].textContent = def.name;
    ui['menu-mission-desc'].textContent = def.desc;
    ui['menu-target-code'].textContent = `BAY ${bay.code}`;
    ui['menu-par-time'].textContent = formatPar(def.par);
    ui['menu-mission-tip'].textContent = def.tip;
    const pips = ui['menu-difficulty'].children;
    for (let i = 0; i < pips.length; i += 1) {
      pips[i].classList.toggle('is-on', i < def.difficulty);
    }
  }

  function buildLevelGrid() {
    if (!ui['level-grid']) return;
    const nextIndex = clamp(save.unlocked - 1, 0, LEVELS.length - 1);
    ui['levels-total-stars'].textContent = `${totalStars()} / ${LEVELS.length * 3}`;
    ui['level-grid'].innerHTML = LEVELS.map((def, index) => {
      const unlocked = index < save.unlocked;
      const stars = save.stars[index] || 0;
      const best = save.bestTimes[index];
      const starMarkup = `<span class="level-card-stars">${[0, 1, 2].map((i) => `<i class="${i < stars ? 'is-earned' : ''}"></i>`).join('')}</span>`;
      const lockMarkup = '<span class="level-card-lock"><svg class="icon"><use href="#i-lock"/></svg></span>';
      return [
        `<button class="level-card${unlocked ? '' : ' is-locked'}${index === nextIndex ? ' is-next' : ''}" type="button" data-level="${index}"${unlocked ? '' : ' aria-disabled="true"'}>`,
        '<div class="level-card-top">',
        `<span class="level-card-no">${padNo(index + 1)}</span>`,
        unlocked ? starMarkup : lockMarkup,
        '</div>',
        `<h3>${def.name}</h3>`,
        '<div class="level-card-meta">',
        `<span>${difficultyLabel(def.difficulty)} · ${formatPar(def.par)}</span>`,
        `<span class="level-card-best">${best ? formatTimeLong(best) : '--:--'}</span>`,
        '</div>',
        '</button>'
      ].join('');
    }).join('');
  }

  function syncSettingsUI() {
    document.body.classList.toggle('has-arrows', !!settings.arrows);
    const muted = !settings.sound;
    [ui['menu-sound'], ui['sound-button']].forEach((button) => {
      if (!button) return;
      button.classList.toggle('is-muted', muted);
      button.setAttribute('aria-pressed', muted ? 'true' : 'false');
      button.setAttribute('aria-label', muted ? 'Unmute sound' : 'Mute sound');
    });
    if (ui['sound-setting']) ui['sound-setting'].setAttribute('aria-checked', settings.sound ? 'true' : 'false');
    if (ui['arrows-setting']) ui['arrows-setting'].setAttribute('aria-checked', settings.arrows ? 'true' : 'false');
    if (ui['shake-setting']) ui['shake-setting'].setAttribute('aria-checked', settings.shake ? 'true' : 'false');
    if (ui['sens-range']) ui['sens-range'].value = String(settings.sensitivity);
    if (ui['sens-value']) ui['sens-value'].textContent = `${settings.sensitivity}%`;
    if (ui['quality-control']) {
      const buttons = ui['quality-control'].querySelectorAll('button');
      for (let i = 0; i < buttons.length; i += 1) {
        buttons[i].classList.toggle('is-active', buttons[i].getAttribute('data-quality') === settings.quality);
      }
    }
    audio.setMuted(muted);
  }

  function toggleSound() {
    audio.unlock();
    audio.click();
    settings.sound = !settings.sound;
    persist();
    syncSettingsUI();
    showToast(settings.sound ? 'SOUND ON' : 'SOUND MUTED', 1000);
  }

  function setMenuSceneCar() {
    car.x = 1.4;
    car.z = -6.5;
    car.yaw = 2.35;
    car.speed = 0;
    car.steer = 0;
    car.wheelAngle = 0;
    car.roll = 0;
    car.pitch = 0;
    wheelInput.angle = 0;
    wheelInput.target = 0;
    wheelInput.held = false;
    updateCarVisual(0);
  }

  function showMainMenu(hero) {
    state.mode = 'menu';
    hideScreens();
    showScreen('main-menu');
    setHudActive(false);
    clearInputs();
    if (targetMarker) targetMarker.visible = false;
    if (ui['level-start-card']) ui['level-start-card'].classList.remove('is-visible');
    state.parkHold = 0;
    state.validPark = false;
    if (hero) setMenuSceneCar();
    refreshMenu();
    audio.updateEngine(0, false, false, false);
  }

  function openLevelSelect() {
    audio.click();
    state.mode = 'levels';
    hideScreens();
    showScreen('levels-screen');
    setHudActive(false);
    clearInputs();
    if (targetMarker) targetMarker.visible = false;
    buildLevelGrid();
    const shell = document.querySelector('.levels-shell');
    if (shell) shell.scrollTop = 0;
  }

  function openSettings(from) {
    audio.click();
    settingsReturn = from || 'menu';
    state.mode = 'settings';
    hideScreens();
    showScreen('settings-screen');
    setHudActive(false);
    clearInputs();
    syncSettingsUI();
  }

  function closeSettings() {
    persist();
    const buttons = ui['quality-control'] ? ui['quality-control'].querySelectorAll('button') : [];
    for (let i = 0; i < buttons.length; i += 1) {
      buttons[i].blur();
    }
    if (settingsReturn === 'pause') {
      state.mode = 'paused';
      hideScreens();
      showScreen('pause-screen');
      setHudActive(true);
      updatePauseStats();
    } else {
      showMainMenu(false);
    }
  }

  function updatePauseStats() {
    if (!level) return;
    ui['pause-level-name'].textContent = level.name;
    ui['pause-time'].textContent = formatTime(state.levelTime);
    ui['pause-hits'].textContent = String(state.contacts);
  }

  function pauseGame() {
    if (state.mode !== 'playing') return;
    state.mode = 'paused';
    clearInputs();
    updatePauseStats();
    showScreen('pause-screen');
    audio.updateEngine(0, false, false, false);
    audio.click();
  }

  function resumeGame() {
    if (state.mode !== 'paused') return;
    hideScreens();
    setHudActive(true);
    state.mode = 'playing';
    physics.accumulator = 0;
    clearInputs();
    audio.unlock();
    audio.click();
  }

  function quitToMenu() {
    clearInputs();
    shootRotationNoteStop();
    showMainMenu(true);
  }

  function cycleCamera() {
    state.cameraMode = (state.cameraMode + 1) % CAMERA_MODES.length;
    if (ui['camera-label']) ui['camera-label'].textContent = CAMERA_MODES[state.cameraMode].label;
    showToast(CAMERA_MODES[state.cameraMode].toast, 1100);
    audio.click();
  }

  function updateHudStatic() {
    if (!level) return;
    ui['hud-level'].textContent = padNo(state.levelIndex + 1);
    ui['hud-level-name'].textContent = level.name;
    ui['hud-difficulty'].textContent = difficultyLabel(level.difficulty);
    ui['hud-timer'].textContent = formatTime(state.levelTime);
    ui['hud-hits'].innerHTML = `<b>${state.contacts}</b> CONTACTS`;
    ui['camera-label'].textContent = CAMERA_MODES[state.cameraMode].label;
    ui['start-level-no'].textContent = padNo(state.levelIndex + 1);
    ui['start-difficulty'].textContent = difficultyLabel(level.difficulty);
    ui['start-level-name'].textContent = level.name;
    ui['start-level-desc'].textContent = level.desc;
  }

  function updateHudCounters() {
    if (!ui['hud-hits']) return;
    ui['hud-hits'].innerHTML = `<b>${state.contacts}</b> CONTACTS`;
  }

  function updateParkAssist() {
    if (!targetBay || !ui['assist-title']) return;
    const status = state.parkStatus;
    const checks = [
      [ui['check-inside'], status.inside],
      [ui['check-aligned'], status.aligned],
      [ui['check-stopped'], status.stopped]
    ];
    checks.forEach((entry) => {
      if (entry[0]) entry[0].classList.toggle('is-on', !!entry[1]);
    });

    const distance = status.distance;
    ui['assist-distance'].textContent = `${Math.round(distance)} M`;

    let title = 'ALIGN WITH THE BAY';
    if (status.inside && status.aligned && status.stopped) title = 'HOLD TO SECURE';
    else if (status.inside && status.aligned) title = 'STOP THE CAR';
    else if (status.inside) title = 'STRAIGHTEN UP';
    ui['assist-title'].textContent = title;

    const axes = carAxes(car.yaw);
    const dx = targetBay.x - car.x;
    const dz = targetBay.z - car.z;
    const lateral = dx * axes.rightX + dz * axes.rightZ;
    const ahead = dx * axes.forwardX + dz * axes.forwardZ;
    const angle = Math.atan2(lateral, ahead) * 180 / PI;
    ui['assist-arrow'].setAttribute('transform', `rotate(${angle.toFixed(1)} 20 20)`);

    const ready = status.inside && status.aligned && status.stopped;
    ui['park-assist'].classList.toggle('is-ready', ready);
    const progress = clamp(state.parkHold / PARK_HOLD_TIME, 0, 1);
    if (ui['hold-arc']) ui['hold-arc'].style.strokeDashoffset = String(119.4 * (1 - progress));
  }

  function updateHudDynamic(dt) {
    if (!level) return;
    if (state.mode !== 'playing' && state.mode !== 'paused' && state.mode !== 'complete') return;

    ui['speed-value'].textContent = String(Math.round(Math.abs(car.speed) * 3.6));
    const ratio = clamp(Math.abs(car.speed) / MAX_SPEED_FORWARD, 0, 1);
    if (ui['speed-arc']) {
      ui['speed-arc'].style.strokeDashoffset = String(100 - ratio * 100);
      ui['speed-arc'].style.stroke = car.speed < -0.1 ? '#ff766a' : 'var(--gold)';
    }
    if (ui['wheel-rotor']) {
      ui['wheel-rotor'].style.transform = `rotate(${(wheelInput.angle * MAX_WHEEL_ANGLE * 180 / PI).toFixed(1)}deg)`;
    }
    ui['steering-wheel'].setAttribute('aria-valuenow', String(Math.round(wheelInput.angle * 100)));
    if (state.mode === 'playing') ui['hud-timer'].textContent = formatTime(state.levelTime);

    state.hudTick -= dt;
    if (state.hudTick > 0) return;
    state.hudTick = 0.08;
    updateParkAssist();
  }

  function starsForResult(time, contacts, par) {
    if (contacts === 0 && time <= par * 1.5) return 3;
    if (contacts <= 1 && time <= par * 2.1) return 2;
    return 1;
  }

  function completeLevel(force) {
    if (state.mode !== 'playing' && !force) return;
    if (state.completeDelay < 0) return;
    state.mode = 'complete';
    state.completeDelay = 0;
    car.speed = 0;
    clearInputs();
    wheelInput.angle = 0;
    state.validPark = true;

    const def = LEVELS[state.levelIndex];
    const time = Math.max(0.1, state.levelTime);
    const contacts = state.contacts;
    const stars = starsForResult(time, contacts, def.par);
    const timePenalty = Math.max(0, time - def.par) * 6;
    const score = Math.max(450, Math.round(3000 + stars * 600 - contacts * 320 - timePenalty));
    const award = Math.max(150, Math.round(stars * 450 + Math.max(0, 1200 - contacts * 240 - time * 4)));

    const previousStars = save.stars[state.levelIndex] || 0;
    save.stars[state.levelIndex] = Math.max(previousStars, stars);
    const previousBest = save.bestTimes[state.levelIndex];
    if (!previousBest || time < previousBest) save.bestTimes[state.levelIndex] = time;
    save.unlocked = Math.max(save.unlocked, Math.min(LEVELS.length, state.levelIndex + 2));
    persist();

    state.result = {
      level: state.levelIndex,
      time: time,
      contacts: contacts,
      stars: stars,
      score: score,
      award: award
    };

    const titles = ['', 'BAY SECURED.', 'CLEAN ARRIVAL.', 'PERFECT PARK.'];
    const subs = [
      '',
      'The bay is yours. Keep the paintwork clean and the line tighter next time.',
      'A tidy park with room to polish the line. The captain nodded once.',
      'Not a scratch. Not a wobble. The valet captain is impressed.'
    ];
    ui['complete-title'].textContent = titles[stars];
    ui['complete-sub'].textContent = subs[stars];
    ui['complete-time'].textContent = formatTime(time);
    ui['complete-hits'].textContent = String(contacts);
    ui['complete-score'].textContent = formatScore(score);
    ui['complete-award'].textContent = `+${formatScore(award)}`;
    ui['complete-star-count'].textContent = String(stars);
    for (let i = 0; i < ui['complete-stars'].children.length; i += 1) {
      ui['complete-stars'].children[i].classList.toggle('is-earned', i < stars);
    }
    if (state.levelIndex >= LEVELS.length - 1) {
      ui['next-level'].innerHTML = '<span class="btn-icon"><svg class="icon"><use href="#i-parking"/></svg></span><span class="btn-copy"><strong>MISSION GRID</strong><small>ALL BAYS CLEARED</small></span>';
    } else {
      ui['next-level'].innerHTML = '<span class="btn-icon"><svg class="icon"><use href="#i-play"/></svg></span><span class="btn-copy"><strong>NEXT MISSION</strong><small>KEEP THE SHIFT MOVING</small></span>';
    }

    setHudActive(false);
    showScreen('complete-screen');
    audio.success();
    refreshMenu();
    showToast(stars === 3 ? 'PERFECT PARK' : 'SHIFT COMPLETE', 1500);
  }

  function startLevel(index, force) {
    const def = LEVELS[index];
    if (!def) return;
    if (!force && index >= save.unlocked) {
      showToast('CLEAR THE PREVIOUS SHIFT TO UNLOCK', 1600);
      openLevelSelect();
      return;
    }
    level = def;
    state.levelIndex = index;
    state.mode = 'playing';
    state.levelTime = 0;
    state.contacts = 0;
    state.parkHold = 0;
    state.validPark = false;
    state.parkStatus = { inside: false, aligned: false, stopped: true, valid: false, distance: 0 };
    state.collisionCooldown = 0;
    state.shake = 0;
    state.started = true;
    state.hudTick = 0;
    state.completeDelay = 0;
    state.result = null;

    hideScreens();
    setHudActive(true);
    if (targetMarker) targetMarker.visible = true;
    buildLevelProps(index);
    resetCarToStart(def);
    setGear(def.gear, true);
    updateHudStatic();
    updateHudCounters();
    snapCameraToCar();
    physics.accumulator = 0;
    clearInputs();
    audio.unlock();
    audio.gearShift();

    ui['level-start-card'].classList.add('is-visible');
    levelCardTimer = 2.6;
    showToast(`SHIFT ${padNo(index + 1)} · ${def.name}`, 1500);
    updateTargetMarker(state.time, false);
  }

  function nextLevel() {
    audio.click();
    if (state.levelIndex < LEVELS.length - 1) {
      startLevel(state.levelIndex + 1, true);
    } else {
      openLevelSelect();
    }
  }

  function handleEscape() {
    if (state.mode === 'playing') pauseGame();
    else if (state.mode === 'paused') resumeGame();
    else if (state.mode === 'settings') closeSettings();
    else if (state.mode === 'levels') showMainMenu(false);
    else if (state.mode === 'complete') showMainMenu(false);
  }

  // Rotation nudge is handled by CSS media queries; this is a no-op hook for boot
  function shootRotationNoteStop() {
    if (ui['rotate-note']) ui['rotate-note'].classList.remove('is-visible');
  }

  /* ===== BOOT CHUNK A: bindings, boot helpers and test harness ===== */
  const runtimeErrors = [];
  let loopStarted = false;
  let lastFrameTime = 0;
  let audioTick = 0;
  let fpsFrames = 0;
  let fpsElapsed = 0;
  let fpsChecked = false;

  window.addEventListener('error', (event) => {
    runtimeErrors.push(event.message || 'Script error');
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    runtimeErrors.push(reason && reason.message ? reason.message : String(reason || 'Promise rejection'));
  });

  function nextFrame() {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      requestAnimationFrame(finish);
      // Headless browsers can pause rAF while still allowing timers; the boot
      // sequence must never hang waiting for a compositor frame.
      setTimeout(finish, 60);
    });
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function setBootProgress(message, percent) {
    if (bootMessage) bootMessage.textContent = message;
    if (bootFill) {
      bootFill.style.animation = 'none';
      bootFill.style.transition = 'width 0.4s ease';
      bootFill.style.width = `${clamp(percent, 0, 100)}%`;
    }
  }

  async function waitForFonts() {
    if (!document.fonts || !document.fonts.load) {
      await delay(120);
      return;
    }
    const loads = [
      document.fonts.load('800 32px Orbitron'),
      document.fonts.load('500 18px Rajdhani'),
      document.fonts.load('600 18px Rajdhani'),
      document.fonts.load('700 18px Rajdhani')
    ].map((promise) => promise.catch(() => null));
    await Promise.race([
      Promise.all(loads).then(() => document.fonts.ready).catch(() => null),
      delay(1800)
    ]);
  }

  function snapToMenuCamera() {
    if (!camera) return;
    const pose = menuCameraPose();
    camState.pos.copy(pose.pos);
    camState.look.copy(pose.look);
    camState.fov = pose.fov;
    camera.position.copy(pose.pos);
    camera.fov = pose.fov;
    camera.updateProjectionMatrix();
    camera.lookAt(pose.look);
  }

  function hideBootScreen() {
    if (!bootScreen) return;
    bootScreen.classList.add('is-hidden');
    setTimeout(() => {
      if (bootScreen) bootScreen.style.display = 'none';
    }, 850);
  }

  function showBootError(error) {
    if (DEBUG) console.error('[APEX] boot failed', error);
    if (bootScreen) {
      bootScreen.style.display = '';
      bootScreen.classList.remove('is-hidden');
      bootScreen.classList.add('is-error');
    }
    if (bootMessage) {
      bootMessage.textContent = `THE DECK FAILED TO LOAD — ${error && error.message ? error.message : error}`;
    }
    if (bootFill) {
      bootFill.style.animation = 'none';
      bootFill.style.width = '100%';
      bootFill.style.background = 'linear-gradient(90deg, #8c2c2c, #ff6058)';
    }
  }

  /* --------------------------------------------------------------------------
     Every button, switch and range on the page
     -------------------------------------------------------------------------- */
  function bindUI() {
    const bindClick = (id, handler) => {
      const el = ui[id] || $(id);
      if (!el) return;
      el.addEventListener('click', (event) => {
        event.preventDefault();
        audio.unlock();
        handler(event);
      });
    };

    bindClick('play-button', () => {
      audio.click();
      startLevel(clamp(save.unlocked - 1, 0, LEVELS.length - 1), true);
    });

    bindClick('levels-button', openLevelSelect);
    bindClick('menu-settings', () => openSettings('menu'));
    bindClick('menu-sound', toggleSound);
    bindClick('sound-button', toggleSound);

    bindClick('camera-button', cycleCamera);
    bindClick('pause-button', pauseGame);
    bindClick('pause-close', resumeGame);
    bindClick('resume-button', resumeGame);

    bindClick('restart-pause', () => {
      audio.click();
      startLevel(state.levelIndex, true);
    });
    bindClick('settings-pause', () => openSettings('pause'));
    bindClick('menu-pause', () => {
      audio.click();
      quitToMenu();
    });

    bindClick('settings-close', () => {
      audio.click();
      closeSettings();
    });
    bindClick('settings-done', () => {
      audio.click();
      closeSettings();
    });

    bindClick('sound-setting', toggleSound);
    bindClick('arrows-setting', () => {
      settings.arrows = !settings.arrows;
      persist();
      syncSettingsUI();
      showToast(settings.arrows ? 'TOUCH ARROWS ON' : 'TOUCH ARROWS OFF', 1100);
      audio.click();
    });
    bindClick('shake-setting', () => {
      settings.shake = !settings.shake;
      persist();
      syncSettingsUI();
      showToast(settings.shake ? 'IMPACT SHAKE ON' : 'IMPACT SHAKE OFF', 1100);
      audio.click();
    });

    if (ui['sens-range']) {
      const range = ui['sens-range'];
      range.addEventListener('input', () => {
        settings.sensitivity = clamp(parseInt(range.value, 10) || 100, 60, 140);
        if (ui['sens-value']) ui['sens-value'].textContent = `${settings.sensitivity}%`;
      });
      range.addEventListener('change', () => {
        persist();
        showToast(`STEERING ${settings.sensitivity}%`, 900);
      });
    }

    if (ui['quality-control']) {
      ui['quality-control'].addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target.closest('button[data-quality]') : null;
        if (!target) return;
        event.preventDefault();
        const quality = target.getAttribute('data-quality');
        if (!quality || quality === settings.quality) return;
        audio.unlock();
        audio.click();
        settings.quality = quality;
        persist();
        syncSettingsUI();
        applyQuality();
        showToast(quality === 'performance' ? 'FAST GRAPHICS' : quality === 'high' ? 'HIGH GRAPHICS' : 'AUTO GRAPHICS', 1100);
      });
    }

    bindClick('levels-close', () => {
      audio.click();
      showMainMenu(true);
    });
    bindClick('levels-back', () => {
      audio.click();
      showMainMenu(true);
    });

    if (ui['level-grid']) {
      ui['level-grid'].addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target.closest('.level-card') : null;
        if (!target) return;
        event.preventDefault();
        audio.unlock();
        const index = parseInt(target.getAttribute('data-level'), 10);
        if (!Number.isInteger(index)) return;
        if (index >= save.unlocked) {
          audio.click();
          showToast(`SHIFT ${padNo(index + 1)} IS LOCKED`, 1400);
          target.classList.remove('is-denied');
          // Restart a tiny CSS animation for feedback
          void target.offsetWidth;
          target.classList.add('is-denied');
          return;
        }
        audio.click();
        startLevel(index, true);
      });
    }

    bindClick('next-level', nextLevel);
    bindClick('retry-button', () => {
      audio.click();
      startLevel(state.levelIndex, true);
    });
    bindClick('complete-levels', openLevelSelect);
    bindClick('complete-menu', () => {
      audio.click();
      showMainMenu(true);
    });

    ['gesturestart', 'gesturechange', 'gestureend'].forEach((name) => {
      document.addEventListener(name, (event) => event.preventDefault(), { passive: false });
    });
    document.addEventListener('dblclick', (event) => {
      if (event.target instanceof Element && event.target.closest('#game-shell')) event.preventDefault();
    }, { passive: false });
  }

  /* --------------------------------------------------------------------------
     Debug / automated test API
     -------------------------------------------------------------------------- */
  function simulatePhysics(seconds) {
    const total = clamp(Number(seconds) || 0, 0, 12);
    const steps = Math.max(1, Math.round(total / physics.step));
    for (let i = 0; i < steps; i += 1) updatePhysicsStep(physics.step);
    car.wheelSpin = car.wheelSpin || 0;
    updateCarVisual(0);
    updateHudCounters();
    return {
      x: car.x,
      z: car.z,
      yaw: car.yaw,
      speed: car.speed,
      mode: state.mode
    };
  }

  function installTestApi() {
    window.__APEX = {
      levels: LEVELS,
      bays: bays,
      get state() { return state; },
      get car() { return car; },
      get save() { return save; },
      get gear() { return gear; },
      get level() { return level; },
      get targetBay() { return targetBay; },
      get cones() { return levelCones.slice(); },
      get runtimeErrors() { return runtimeErrors.slice(); },
      getParkStatus: getParkStatus,
      startLevel: (index, force) => startLevel(index, force !== false),
      showMenu: (hero) => showMainMenu(hero !== false),
      openLevels: openLevelSelect,
      openSettings: openSettings,
      pause: pauseGame,
      resume: resumeGame,
      setGear: setGear,
      cycleCamera: cycleCamera,
      complete: (force) => completeLevel(force !== false),
      simulate: simulatePhysics,
      teleport: (x, z, yaw) => {
        car.x = Number(x) || 0;
        car.z = Number(z) || 0;
        if (Number.isFinite(yaw)) car.yaw = yaw;
        car.speed = 0;
        car.steer = 0;
        car.wheelAngle = 0;
        updateCarVisual(0);
        snapCameraToCar();
        return { x: car.x, z: car.z, yaw: car.yaw };
      },
      park: (offsetX, offsetZ, yawOffset) => {
        if (!targetBay) return null;
        car.x = targetBay.x + (Number(offsetX) || 0);
        car.z = targetBay.z + (Number(offsetZ) || 0);
        car.yaw = targetBay.yaw + (Number(yawOffset) || 0);
        car.speed = 0;
        car.steer = 0;
        car.wheelAngle = 0;
        updateCarVisual(0);
        snapCameraToCar();
        return getParkStatus();
      },
      selfTest: () => runSelfTest()
    };
  }

  /* ===== BOOT CHUNK B: boot sequence and render loop ===== */
  function trackPerformance(dt) {
    if (settings.quality !== 'auto' || fpsChecked || !renderer || state.mode !== 'playing') return;
    fpsFrames += 1;
    fpsElapsed += dt;
    if (fpsElapsed < 3.2) return;
    const fps = fpsFrames / Math.max(0.001, fpsElapsed);
    fpsFrames = 0;
    fpsElapsed = 0;
    if (fps < 40 && renderer.getPixelRatio() > 1.01) {
      renderer.setPixelRatio(1);
      onResize();
      fpsChecked = true;
      if (DEBUG) console.log('[APEX] auto graphics reduced pixel ratio', fps.toFixed(1));
    } else if (fps >= 40) {
      fpsChecked = true;
    }
  }

  function frame(now) {
    if (!loopStarted) return;
    requestAnimationFrame(frame);

    if (!lastFrameTime) lastFrameTime = now;
    let dt = (now - lastFrameTime) / 1000;
    lastFrameTime = now;
    if (!Number.isFinite(dt) || dt <= 0) dt = 0.0001;
    dt = Math.min(dt, 0.05);
    state.time += dt;

    if (state.mode === 'playing') {
      state.levelTime += dt;
      updatePhysics(dt);
      if (levelCardTimer > 0) {
        levelCardTimer = Math.max(0, levelCardTimer - dt);
        if (levelCardTimer === 0 && ui['level-start-card']) {
          ui['level-start-card'].classList.remove('is-visible');
        }
      }
    }

    updateCarVisual(dt);

    if (targetMarker && targetMarker.visible) {
      updateTargetMarker(state.time, state.validPark);
    }

    if (state.mode !== 'boot') updateCamera(dt, false);
    updateHudDynamic(dt);

    if (state.shake > 0) {
      state.shake = Math.max(0, state.shake - dt * 2.8);
      if (state.shake < 0.002) state.shake = 0;
    }

    audioTick -= dt;
    if (audioTick <= 0) {
      audioTick = 0.09;
      const driving = state.mode === 'playing';
      audio.updateEngine(car.speed, driving && input.gas, driving && input.brake, driving);
    }

    trackPerformance(dt);

    if (renderer && scene && camera) renderer.render(scene, camera);
  }

  function startLoop() {
    if (loopStarted) return;
    loopStarted = true;
    lastFrameTime = 0;
    requestAnimationFrame(frame);
  }

  function clearIntroOverlays() {
    levelCardTimer = 0;
    if (ui['level-start-card']) ui['level-start-card'].classList.remove('is-visible');
    if (ui.toast) ui.toast.classList.remove('is-visible');
    clearTimeout(toastTimer);
  }

  function registerOfflineCache() {
    if (!('serviceWorker' in navigator)) return;
    if (!/^https?:$/.test(window.location.protocol)) return;
    if (window.Capacitor) return;
    if (DEBUG || SELF_TEST) return;
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* Offline acceleration is optional; the game also runs from disk. */
    });
  }

  function applyLaunchMode() {
    const match = window.location.search.match(/[?&]level=(\d+)/i);
    const requestedLevel = clamp((match ? parseInt(match[1], 10) : 1) - 1, 0, LEVELS.length - 1);

    if (SHOT) {
      showMainMenu(true);
      if (SHOT === 'levels') {
        openLevelSelect();
      } else if (SHOT === 'settings') {
        openSettings('menu');
      } else if (SHOT === 'game' || SHOT === 'cockpit' || SHOT === 'close' || SHOT === 'top' || SHOT === 'park' || SHOT === 'complete') {
        startLevel(requestedLevel, true);
        if (SHOT === 'cockpit') state.cameraMode = 2;
        else if (SHOT === 'close') state.cameraMode = 1;
        else if (SHOT === 'top') state.cameraMode = 3;
        if (SHOT === 'cockpit' || SHOT === 'close' || SHOT === 'top') {
          ui['camera-label'].textContent = CAMERA_MODES[state.cameraMode].label;
          snapCameraToCar();
        }
        if (SHOT === 'park') {
          state.cameraMode = 3;
          if (targetBay) {
            car.x = targetBay.x;
            car.z = targetBay.z;
            car.yaw = targetBay.yaw;
            car.speed = 0;
            updateCarVisual(0);
            state.parkStatus = getParkStatus();
            state.validPark = true;
            updateParkAssist();
          }
          ui['camera-label'].textContent = CAMERA_MODES[state.cameraMode].label;
          snapCameraToCar();
        }
        if (SHOT === 'complete') {
          const def = LEVELS[requestedLevel];
          if (targetBay) {
            car.x = targetBay.x;
            car.z = targetBay.z;
            car.yaw = targetBay.yaw;
            car.speed = 0;
            updateCarVisual(0);
          }
          state.levelTime = Math.max(18, def.par * 0.88);
          state.contacts = 0;
          snapCameraToCar();
          completeLevel(true);
        }
      }
      clearIntroOverlays();
      if (DEBUG) console.log('[APEX] screenshot mode', SHOT, 'level', requestedLevel + 1);
    } else if (match && !SELF_TEST) {
      startLevel(requestedLevel, true);
    }

    window.__APEX_READY__ = true;
    document.documentElement.classList.add('is-ready');
    registerOfflineCache();

    if (SELF_TEST) {
      setTimeout(() => {
        try {
          runSelfTest();
        } catch (error) {
          runtimeErrors.push(error && error.message ? error.message : String(error));
          if (DEBUG) console.error('[APEX] self-test crashed', error);
        }
      }, 520);
    }
  }

  async function bootGame() {
    if (SELF_TEST) document.documentElement.classList.add('is-selftest');
    cacheUI();
    bindUI();
    bindDrivingInputs();
    syncSettingsUI();

    setBootProgress('PREPARING THE DECK', 6);
    await nextFrame();

    try {
      setupRenderer();
      setupLights();
      applyQuality();

      if (renderer && renderer.domElement) {
        renderer.domElement.addEventListener('webglcontextlost', (event) => {
          event.preventDefault();
          showToast('GRAPHICS CONTEXT LOST — RELOAD THE PAGE', 5000);
        });
      }

      setBootProgress('WARMING THE LIGHTS', 18);
      await nextFrame();
      await waitForFonts();

      setBootProgress('PAINTING THE ASPHALT', 34);
      createSharedAssets();
      createEnvironmentMap();
      await nextFrame();

      setBootProgress('BUILDING THE SKYLINE', 50);
      buildSky();
      buildCity();
      await nextFrame();

      setBootProgress('MARKING THE BAYS', 66);
      buildDeck();
      await nextFrame();

      setBootProgress('DETAILING THE COUPE', 80);
      buildPlayerCar();
      createTargetMarker();
      buildLevelProps(0);
      await nextFrame();

      setBootProgress('TUNING THE CAMERAS', 92);
      showMainMenu(true);
      snapToMenuCamera();
      installTestApi();
      startLoop();
      await nextFrame();
      if (renderer && scene && camera) renderer.render(scene, camera);

      setBootProgress('OPENING THE GATES', 100);
      await delay(240);
      hideBootScreen();
      applyLaunchMode();

      if (DEBUG) {
        console.log('[APEX] ready', {
          levels: LEVELS.length,
          colliders: staticColliders.length,
          bays: bays.north.length + bays.south.length + (bays.parallel ? 1 : 0)
        });
      }
    } catch (error) {
      showBootError(error);
    }
  }

  /* ===== BOOT CHUNK C: automated self-test ===== */
  async function runSelfTest() {
    const results = [];
    const original = {
      unlocked: save.unlocked,
      stars: JSON.parse(JSON.stringify(save.stars)),
      bestTimes: JSON.parse(JSON.stringify(save.bestTimes)),
      settings: Object.assign({}, settings)
    };
    const check = (name, condition, detail) => {
      let ok = false;
      let note = detail || '';
      try {
        ok = !!condition();
      } catch (error) {
        note = error && error.message ? error.message : String(error);
      }
      results.push({ name: name, ok: ok, detail: note });
      return ok;
    };
    const visible = (id) => {
      const el = $(id);
      return !!el && el.classList.contains('is-visible');
    };
    const q = (selector) => document.querySelector(selector);

    try {
      showMainMenu(true);

      /* -- world and static content ------------------------------------- */
      check('Three.js core is loaded', () => !!window.THREE && !!THREE.REVISION, THREE && THREE.REVISION);
      check('WebGL renderer is live', () => !!renderer && !!renderer.getContext() && renderer.domElement.isConnected);
      check('World contains geometry', () => !!scene && scene.children.length >= 12, scene ? `children=${scene.children.length}` : 'no scene');
      check('Player coupe is assembled', () => !!CAR.body && CAR.wheels.length === 4 && CAR.frontPivots.length === 2);
      check('Eight missions are defined', () => LEVELS.length === 8, `levels=${LEVELS.length}`);
      check('Parking bay grid is built', () => bays.north.length === 12 && bays.south.length === 10 && !!bays.parallel,
        `north=${bays.north.length} south=${bays.south.length}`);
      check('Every target bay resolves', () => LEVELS.every((def) => !!resolveBay(def.target)));
      check('Solid colliders are registered', () => staticColliders.length > 10, `colliders=${staticColliders.length}`);
      check('Target marker is prepared', () => !!targetMarker && !!targetMarker.userData.fill);

      check('Main menu is presented', () => state.mode === 'menu' && visible('main-menu') && !ui.hud.classList.contains('is-active'));
      buildLevelGrid();
      check('Mission grid renders eight cards', () => document.querySelectorAll('#level-grid .level-card').length === 8);
      check('Menu progress is populated', () => /\/\s*8/.test(ui['menu-progress-label'].textContent), ui['menu-progress-label'].textContent);

      /* -- primary navigation ------------------------------------------- */
      const expectedPlay = clamp(save.unlocked - 1, 0, LEVELS.length - 1);
      ui['play-button'].click();
      await delay(380);
      check('Play button launches the next shift', () => state.mode === 'playing' && state.levelIndex === expectedPlay,
        `mode=${state.mode} level=${state.levelIndex + 1} expected=${expectedPlay + 1}`);
      check('HUD mission readout is populated', () => ui['hud-level'].textContent === padNo(state.levelIndex + 1) &&
        ui['hud-level-name'].textContent === level.name && ui['hud-timer'].textContent === '00:00');
      check('Touch controls become active', () => ui.hud.classList.contains('is-active') && ui.hud.getAttribute('aria-hidden') === 'false');

      /* -- responsive layout -------------------------------------------- */
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const rectOf = (selector) => ui.hud.querySelector(selector).getBoundingClientRect();
      const withinScreen = (rect) => rect.width > 0 && rect.height > 0 &&
        rect.left >= -1 && rect.top >= -1 && rect.right <= vw + 1 && rect.bottom <= vh + 1;
      const clearCentre = (el) => {
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) return false;
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
      };
      const overlap = (a, b) =>
        Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 &&
        Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2;

      check('HUD fits the viewport without scrolling', () => document.documentElement.scrollWidth <= vw + 1 &&
        withinScreen(rectOf('.hud-top')) && withinScreen(rectOf('.hud-bottom')),
      `viewport=${vw}x${vh} scrollWidth=${document.documentElement.scrollWidth}`);
      const criticalControls = [
        ui['steering-wheel'], ui['gas-pedal'], ui['brake-pedal'],
        q('.gear-button[data-gear="D"]'), ui['camera-button'], ui['pause-button']
      ];
      const hudStyle = getComputedStyle(ui.hud);
      const wheelStyle = getComputedStyle(ui['steering-wheel']);
      check('HUD is fully revealed for touch input', () => hudStyle.visibility === 'visible' &&
        parseFloat(hudStyle.opacity) > 0.95 && wheelStyle.pointerEvents === 'auto',
      `visibility=${hudStyle.visibility} opacity=${hudStyle.opacity} hudPE=${hudStyle.pointerEvents} wheelPE=${wheelStyle.pointerEvents} scroll=${window.scrollX},${window.scrollY}`);
      const controlProblems = criticalControls.filter((el) => !el ||
        !withinScreen(el.getBoundingClientRect()) || !clearCentre(el)).map((el) => {
        if (!el) return 'missing';
        const rect = el.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        const stack = document.elementsFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)
          .slice(0, 3).map((node) => node.id || node.className || node.tagName).join('>');
        return `${el.id || el.className} [${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.width)}x${Math.round(rect.height)}] hits ${hit ? (hit.id || hit.className || hit.tagName) : 'null'} stack=${stack}`;
      });
      check('Driving controls are on screen and unobstructed', () => controlProblems.length === 0, controlProblems.join(' | '));
      check('Steering, speed and pedal clusters do not overlap', () => {
        const steer = rectOf('.steer-zone');
        const speed = rectOf('.speed-zone');
        const pedals = rectOf('.pedal-zone');
        return !overlap(steer, speed) && !overlap(speed, pedals) && !overlap(steer, pedals);
      }, `vw=${vw}`);
      check('Touch targets are large enough to use', () => {
        const wheel = ui['steering-wheel'].getBoundingClientRect();
        const gas = ui['gas-pedal'].getBoundingClientRect();
        const brake = ui['brake-pedal'].getBoundingClientRect();
        const gear = q('.gear-button[data-gear="D"]').getBoundingClientRect();
        const cameraRect = ui['camera-button'].getBoundingClientRect();
        return wheel.width >= 86 && gas.width >= 58 && gas.height >= 78 &&
          brake.width >= 44 && brake.height >= 66 && gear.width >= 24 && gear.height >= 22 &&
          cameraRect.width >= 36 && cameraRect.height >= 36;
      }, `vw=${vw}`);
      check('Optional steering arrows still fit the HUD', () => {
        document.body.classList.add('has-arrows');
        const steer = rectOf('.steer-zone');
        const speed = rectOf('.speed-zone');
        const pedals = rectOf('.pedal-zone');
        const left = ui['arrow-left'].getBoundingClientRect();
        const right = ui['arrow-right'].getBoundingClientRect();
        const ok = withinScreen(steer) && withinScreen(speed) && withinScreen(pedals) &&
          !overlap(steer, speed) && !overlap(speed, pedals) && !overlap(steer, pedals) &&
          left.width >= 30 && left.height >= 48 && right.width >= 30 && right.height >= 48 &&
          withinScreen(left) && withinScreen(right);
        document.body.classList.remove('has-arrows');
        return ok;
      }, `vw=${vw}`);

      /* -- gears, camera, pause ----------------------------------------- */
      const gearN = q('.gear-button[data-gear="N"]');
      const gearR = q('.gear-button[data-gear="R"]');
      const gearD = q('.gear-button[data-gear="D"]');
      if (gearN) gearN.click();
      check('Touch gear selector selects neutral', () => gear === 'N' && gearN.getAttribute('aria-pressed') === 'true');
      if (gearR) gearR.click();
      check('Touch gear selector selects reverse', () => gear === 'R' && gearR.getAttribute('aria-pressed') === 'true');
      if (gearD) gearD.click();
      check('Touch gear selector returns to drive', () => gear === 'D' && gearD.getAttribute('aria-pressed') === 'true');

      state.cameraMode = 0;
      ui['camera-button'].click();
      check('Camera button cycles views', () => state.cameraMode === 1 && ui['camera-label'].textContent === 'CLOSE',
        `mode=${state.cameraMode} label=${ui['camera-label'].textContent}`);
      ui['camera-button'].click();
      ui['camera-button'].click();
      ui['camera-button'].click();
      check('Camera cycles back through all four views', () => state.cameraMode === 0 && ui['camera-label'].textContent === 'CHASE');

      ui['pause-button'].click();
      check('Pause button opens the pause screen', () => state.mode === 'paused' && visible('pause-screen'));
      ui['pause-close'].click();
      check('Pause close button resumes driving', () => state.mode === 'playing' && ui.hud.classList.contains('is-active'));
      ui['pause-button'].click();
      ui['resume-button'].click();
      check('Resume button returns to the bay', () => state.mode === 'playing' && visible('pause-screen') === false);
      ui['pause-button'].click();
      state.levelTime = 12;
      ui['restart-pause'].click();
      check('Restart from pause resets the shift', () => state.mode === 'playing' && state.levelIndex === expectedPlay && state.levelTime < 0.05);

      ui['pause-button'].click();
      ui['settings-pause'].click();
      check('Settings open above a paused shift', () => state.mode === 'settings' && visible('settings-screen'));
      ui['settings-close'].click();
      check('Settings close returns to the pause screen', () => state.mode === 'paused' && visible('pause-screen'));
      ui['resume-button'].click();
      ui['pause-button'].click();
      ui['menu-pause'].click();
      check('Quit to menu from pause works', () => state.mode === 'menu' && visible('main-menu'));

      /* -- settings ----------------------------------------------------- */
      ui['menu-settings'].click();
      check('Menu settings button opens garage setup', () => state.mode === 'settings' && visible('settings-screen'));
      const arrowStart = settings.arrows;
      ui['arrows-setting'].click();
      check('Steering arrow switch updates UI and body', () => settings.arrows === !arrowStart &&
        document.body.classList.contains('has-arrows') === !arrowStart &&
        ui['arrows-setting'].getAttribute('aria-checked') === String(!arrowStart));
      ui['arrows-setting'].click();
      check('Steering arrow switch restores', () => settings.arrows === arrowStart);
      const shakeStart = settings.shake;
      ui['shake-setting'].click();
      check('Camera shake switch toggles', () => settings.shake === !shakeStart &&
        ui['shake-setting'].getAttribute('aria-checked') === String(!shakeStart));
      ui['shake-setting'].click();
      const soundStart = settings.sound;
      ui['sound-setting'].click();
      check('Sound switch toggles audio', () => settings.sound === !soundStart &&
        ui['sound-setting'].getAttribute('aria-checked') === String(!soundStart));
      ui['sound-setting'].click();
      check('Sound switch restores audio', () => settings.sound === soundStart);

      const sensStart = settings.sensitivity;
      const range = ui['sens-range'];
      if (range) {
        range.value = '125';
        range.dispatchEvent(new Event('input', { bubbles: true }));
        const sensLabel = ui['sens-value'].textContent;
        range.dispatchEvent(new Event('change', { bubbles: true }));
        check('Steering sensitivity slider responds', () => sensLabel === '125%' && settings.sensitivity === 125, `label=${sensLabel}`);
        range.value = String(sensStart);
        range.dispatchEvent(new Event('input', { bubbles: true }));
        range.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const highButton = ui['quality-control'] ? ui['quality-control'].querySelector('[data-quality="high"]') : null;
      const autoButton = ui['quality-control'] ? ui['quality-control'].querySelector('[data-quality="auto"]') : null;
      if (highButton) highButton.click();
      check('Graphics quality selector applies high detail', () => settings.quality === 'high' && !!highButton && highButton.classList.contains('is-active'));
      if (autoButton) autoButton.click();
      check('Graphics quality returns to auto', () => settings.quality === 'auto' && !!autoButton && autoButton.classList.contains('is-active'));
      ui['settings-done'].click();
      check('Settings done returns to the menu', () => state.mode === 'menu' && visible('main-menu'));

      const menuSound = settings.sound;
      ui['menu-sound'].click();
      check('Menu sound button mutes', () => settings.sound === !menuSound && ui['menu-sound'].classList.contains('is-muted') === !settings.sound);
      ui['menu-sound'].click();
      check('Menu sound button restores the sound setting', () => settings.sound === menuSound &&
        ui['menu-sound'].classList.contains('is-muted') === !settings.sound);

      /* -- touch pedals and wheel --------------------------------------- */
      startLevel(0, true);
      const gasEl = ui['gas-pedal'];
      const gasRect = gasEl.getBoundingClientRect();
      gasEl.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, pointerId: 701, pointerType: 'touch', isPrimary: true, buttons: 1,
        clientX: gasRect.left + gasRect.width / 2, clientY: gasRect.top + gasRect.height / 2
      }));
      const gasHeld = input.gas && gasEl.classList.contains('is-pressed');
      gasEl.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, cancelable: true, pointerId: 701, pointerType: 'touch', isPrimary: true, buttons: 0,
        clientX: gasRect.left + gasRect.width / 2, clientY: gasRect.top + gasRect.height / 2
      }));
      check('Touch accelerator holds and releases cleanly', () => gasHeld && !input.gas && !gasEl.classList.contains('is-pressed'));

      const brakeEl = ui['brake-pedal'];
      const brakeRect = brakeEl.getBoundingClientRect();
      brakeEl.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, pointerId: 702, pointerType: 'touch', isPrimary: true, buttons: 1,
        clientX: brakeRect.left + brakeRect.width / 2, clientY: brakeRect.top + brakeRect.height / 2
      }));
      const brakeHeld = input.brake && brakeEl.classList.contains('is-pressed');
      brakeEl.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, cancelable: true, pointerId: 702, pointerType: 'touch', isPrimary: true, buttons: 0,
        clientX: brakeRect.left + brakeRect.width / 2, clientY: brakeRect.top + brakeRect.height / 2
      }));
      check('Touch brake pedal holds and releases cleanly', () => brakeHeld && !input.brake && !brakeEl.classList.contains('is-pressed'));

      const wheelEl = ui['steering-wheel'];
      const wheelRect = wheelEl.getBoundingClientRect();
      wheelEl.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, cancelable: true, pointerId: 703, pointerType: 'touch', isPrimary: true, buttons: 1,
        clientX: wheelRect.left + wheelRect.width * 0.8, clientY: wheelRect.top + wheelRect.height / 2
      }));
      const wheelHeld = wheelInput.held;
      const wheelTarget = wheelInput.target;
      wheelEl.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true, cancelable: true, pointerId: 703, pointerType: 'touch', isPrimary: true, buttons: 0,
        clientX: wheelRect.left + wheelRect.width * 0.8, clientY: wheelRect.top + wheelRect.height / 2
      }));
      check('Touch steering wheel drags and springs back', () => wheelHeld && wheelTarget > 0.2 &&
        !wheelInput.held && wheelInput.target === 0, `held=${wheelHeld} target=${wheelTarget.toFixed(2)}`);

      window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', key: 'w', bubbles: true }));
      const keyThrottle = input.gas;
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', key: 'w', bubbles: true }));
      check('Keyboard throttle mirrors the pedal', () => keyThrottle && !input.gas);

      /* -- driving, steering, collisions, parking ----------------------- */
      startLevel(0, true);
      input.gas = true;
      simulatePhysics(1.3);
      input.gas = false;
      const accelSpeed = car.speed;
      const accelZ = car.z;
      check('Throttle accelerates the coupe', () => accelSpeed > 1.2 && accelZ < 3.4,
        `speed=${accelSpeed.toFixed(2)} z=${accelZ.toFixed(2)}`);
      input.brake = true;
      simulatePhysics(1.5);
      input.brake = false;
      check('Brake brings the coupe to rest', () => Math.abs(car.speed) < 0.2, `speed=${car.speed.toFixed(2)}`);

      startLevel(0, true);
      setGear('R');
      input.gas = true;
      simulatePhysics(1.2);
      input.gas = false;
      const reverseSpeed = car.speed;
      const reverseZ = car.z;
      input.brake = true;
      simulatePhysics(1);
      input.brake = false;
      check('Reverse gear backs the car up', () => reverseSpeed < -0.5 && reverseZ > 4.6,
        `speed=${reverseSpeed.toFixed(2)} z=${reverseZ.toFixed(2)}`);

      startLevel(0, true);
      input.left = true;
      simulatePhysics(0.6);
      const leftAngle = wheelInput.angle;
      const pivotAngle = CAR.frontPivots[0].rotation.y;
      input.left = false;
      simulatePhysics(1);
      check('Steering turns the wheel and auto-centres', () => leftAngle < -0.35 && pivotAngle > 0.05 && Math.abs(wheelInput.angle) < 0.05,
        `input=${leftAngle.toFixed(2)} pivot=${pivotAngle.toFixed(2)} rest=${wheelInput.angle.toFixed(3)}`);

      startLevel(0, true);
      state.contacts = 0;
      car.x = 0;
      car.z = 21;
      car.yaw = PI;
      car.speed = 6;
      car.steer = 0;
      car.wheelAngle = 0;
      updateCarVisual(0);
      simulatePhysics(0.8);
      check('Solid walls stop and penalise the car', () => state.contacts > 0 &&
        car.z <= LOT.maxZ - CAR_HALF_LENGTH + 0.03 && Math.abs(car.speed) < 1.5,
        `contacts=${state.contacts} z=${car.z.toFixed(2)} speed=${car.speed.toFixed(2)}`);

      startLevel(4, true);
      state.contacts = 0;
      const testCone = levelCones[0];
      const coneCount = levelCones.length;
      if (testCone) {
        car.x = testCone.x;
        car.z = testCone.z;
        car.yaw = 0;
        car.speed = 0;
        updateCarVisual(0);
        simulatePhysics(0.2);
      }
      check('Cones react to contact', () => coneCount > 0 && !!testCone && testCone.fallen && state.contacts >= 1,
        `cones=${coneCount} fallen=${testCone ? testCone.fallen : 'n/a'} contacts=${state.contacts}`);

      startLevel(0, true);
      const bay = targetBay;
      state.levelTime = Math.max(10, level.par - 4);
      state.contacts = 0;
      car.x = bay.x;
      car.z = bay.z;
      car.yaw = bay.yaw;
      car.speed = 0;
      car.steer = 0;
      car.wheelAngle = 0;
      updateCarVisual(0);
      const parkedStatus = getParkStatus();
      simulatePhysics(1.05);
      check('Target bay recognises a clean park', () => parkedStatus.inside && parkedStatus.aligned && parkedStatus.stopped && parkedStatus.valid,
        JSON.stringify(parkedStatus));
      check('Park hold completes the mission', () => state.mode === 'complete' && visible('complete-screen'), `mode=${state.mode}`);
      const earnedStars = save.stars[0] || 0;
      check('Completion awards stars and unlocks progress', () => earnedStars >= 1 && save.unlocked >= 2,
        `stars=${earnedStars} unlocked=${save.unlocked}`);
      check('Completion screen shows the result', () => ui['complete-score'].textContent.length > 0 &&
        ui['complete-star-count'].textContent === String(earnedStars) && ui['complete-time'].textContent !== '00:00');

      ui['next-level'].click();
      check('Next mission button advances the career', () => state.mode === 'playing' && state.levelIndex === 1,
        `mode=${state.mode} level=${state.levelIndex + 1}`);
      ui['pause-button'].click();
      ui['menu-pause'].click();

      /* -- mission grid, complete screen buttons ------------------------ */
      ui['levels-button'].click();
      check('Mission grid opens from the menu', () => state.mode === 'levels' && visible('levels-screen'));
      const gridCards = document.querySelectorAll('#level-grid .level-card');
      check('Mission grid contains every shift', () => gridCards.length === 8, `cards=${gridCards.length}`);
      if (gridCards[0]) gridCards[0].click();
      check('Mission card launches its bay', () => state.mode === 'playing' && state.levelIndex === 0);
      ui['pause-button'].click();
      ui['menu-pause'].click();
      ui['levels-button'].click();
      ui['levels-close'].click();
      check('Mission grid close button returns to menu', () => state.mode === 'menu' && visible('main-menu'));
      ui['levels-button'].click();
      ui['levels-back'].click();
      check('Mission grid back button returns to menu', () => state.mode === 'menu' && visible('main-menu'));

      startLevel(0, true);
      state.levelTime = 35;
      completeLevel(true);
      ui['complete-levels'].click();
      check('Complete screen missions button opens the grid', () => state.mode === 'levels' && visible('levels-screen'));
      ui['levels-back'].click();
      startLevel(0, true);
      state.levelTime = 35;
      completeLevel(true);
      ui['complete-menu'].click();
      check('Complete screen menu button returns to menu', () => state.mode === 'menu' && visible('main-menu'));
      startLevel(0, true);
      state.levelTime = 35;
      completeLevel(true);
      ui['retry-button'].click();
      check('Complete screen retry restarts the bay', () => state.mode === 'playing' && state.levelIndex === 0 && state.levelTime < 0.05);
      ui['pause-button'].click();
      ui['menu-pause'].click();

      /* -- persistence, drawing and runtime health ---------------------- */
      persist();
      const stored = readJSON(SAVE_KEY, null);
      check('Progress persists to localStorage', () => !!stored && stored.version === 1 && !!stored.settings && typeof stored.settings.sound === 'boolean');

      renderer.render(scene, camera);
      check('Renderer draws the live scene', () => renderer.info.render.calls > 10, `draw calls=${renderer.info.render.calls}`);
      check('No uncaught JavaScript errors', () => runtimeErrors.length === 0, runtimeErrors.join(' | '));
    } catch (error) {
      results.push({ name: 'Self-test harness completed', ok: false, detail: error && error.message ? error.message : String(error) });
    } finally {
      save.unlocked = original.unlocked;
      save.stars = JSON.parse(JSON.stringify(original.stars));
      save.bestTimes = JSON.parse(JSON.stringify(original.bestTimes));
      Object.keys(settings).forEach((key) => delete settings[key]);
      Object.assign(settings, original.settings);
      save.settings = settings;
      persist();
      syncSettingsUI();
      applyQuality();
      buildLevelGrid();
      refreshMenu();
      showMainMenu(true);
      snapToMenuCamera();

      const failed = results.filter((result) => !result.ok);
      const passed = results.length - failed.length;
      const lines = results.map((result) => `${result.ok ? 'PASS' : 'FAIL'}  ${result.name}${result.detail ? `  [${result.detail}]` : ''}`);
      const text = [
        'APEX PARKING 3D — AUTOMATED SELF-TEST',
        `RESULT: ${failed.length === 0 ? 'PASS' : 'FAIL'} · ${passed}/${results.length} CHECKS`,
        '',
        lines.join('\n')
      ].join('\n');

      if (ui['selftest-results']) {
        ui['selftest-results'].removeAttribute('hidden');
        ui['selftest-results'].textContent = text;
        ui['selftest-results'].classList.toggle('is-fail', failed.length > 0);
      }
      document.title = failed.length === 0 ? 'SELFTEST PASS' : 'SELFTEST FAIL';
      window.__SELFTEST__ = {
        pass: failed.length === 0,
        passed: passed,
        total: results.length,
        failures: failed.map((result) => result.name),
        results: results,
        text: text
      };
      if (window.console && console.log) console.log(text);
    }
  }

  bootGame();
})();

