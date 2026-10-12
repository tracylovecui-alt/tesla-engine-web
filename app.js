/* Original browser synthesizer. No vehicle API or third-party audio assets. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const smooth = (dt, tau) => 1 - Math.exp(-dt / tau);
  const profiles = {
    muscle: { idle: 780, redline: 6500, cylinders: 8, ratios: [3.4, 2.25, 1.6, 1.2, 0.95, 0.74], final: 3.3, tire: 2.15, shift: 5700, cruise: 2600, color: '#ff8557' },
    sport: { idle: 1000, redline: 8500, cylinders: 10, ratios: [3.8, 2.65, 1.95, 1.48, 1.18, 0.94, 0.78], final: 3.7, tire: 2.2, shift: 7700, cruise: 3400, color: '#ff8557' },
    future: { idle: 1100, redline: 9000, cylinders: 0, ratios: [1], final: 5.5, tire: 2.1, shift: 9000, cruise: 9000, color: '#ff8557' }
  };
  let selected = 'muscle', mode = 'demo', running = false, starting = false;
  let volume = 35, intensity = 55, shiftsEnabled = true, autoDemo = false, demoTime = 0;
  let speed = 0, accel = 0, throttle = 0, rpm = 0, gear = 0, gearAge = 0;
  let shiftUntil = 0, lastFrame = performance.now(), lastPaint = 0;
  let watchId = null, anchor = null, gpsRaw = null, gpsFiltered = 0, gpsAcceleration = 0;
  let gpsReceived = null, gpsAccuracy = null, gpsState = 'off', gpsRejects = 0;
  let audio = null, wakeLock = null, wakeWanted = false, audioRecovery = false;
  let runGeneration = 0;
  const notice = message => { $('notice').textContent = message; };

  function loadSettings() {
    try {
      const s = JSON.parse(localStorage.getItem('drivetone-settings') || '{}');
      if (profiles[s.profile]) selected = s.profile;
      if (Number.isFinite(s.volume)) volume = clamp(s.volume, 0, 100);
      if (Number.isFinite(s.intensity)) intensity = clamp(s.intensity, 0, 100);
      if (typeof s.shift === 'boolean') shiftsEnabled = s.shift;
    } catch (_) { /* Local storage may be unavailable in a vehicle browser. */ }
    $('volume').value = volume; $('intensity').value = intensity; $('shift-sound').checked = shiftsEnabled;
  }
  function saveSettings() {
    try { localStorage.setItem('drivetone-settings', JSON.stringify({ profile: selected, volume, intensity, shift: shiftsEnabled })); } catch (_) {}
  }

  class Synth {
    constructor(context) {
      this.context = context;
      this.voices = [];
      this.noiseSource = null;
      this.master = context.createGain(); this.master.gain.value = 0;
      this.limiter = context.createDynamicsCompressor();
      this.limiter.threshold.value = -12; this.limiter.knee.value = 8; this.limiter.ratio.value = 8;
      this.limiter.attack.value = 0.005; this.limiter.release.value = 0.15;
      // Exhaust saturation and a fixed body resonance sit below the moving intake filter.
      this.drive = context.createGain(); this.drive.gain.value = 1;
      this.saturation = context.createWaveShaper();
      this.saturation.curve = Float32Array.from({ length: 2048 }, (_, i) => Math.tanh((i / 2047 * 2 - 1) * 1.8) / Math.tanh(1.8));
      this.saturation.oversample = '2x';
      this.body = context.createBiquadFilter(); this.body.type = 'peaking'; this.body.Q.value = 0.8;
      this.highpass = context.createBiquadFilter(); this.highpass.type = 'highpass'; this.highpass.frequency.value = 28;
      this.filter = context.createBiquadFilter(); this.filter.type = 'lowpass'; this.filter.Q.value = 0.65;
      this.bus = context.createGain(); this.bus.gain.value = 0.6;
      this.drive.connect(this.saturation); this.saturation.connect(this.body); this.body.connect(this.bus);
      this.bus.connect(this.highpass); this.highpass.connect(this.filter); this.filter.connect(this.limiter); this.limiter.connect(this.master); this.master.connect(context.destination);
      const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
      const data = buffer.getChannelData(0);
      let previous = 0;
      for (let i = 0; i < data.length; i++) { previous = (previous + (Math.random() * 2 - 1) * 0.12) / 1.12; data[i] = previous * 3; }
      this.noise = buffer;
      this.setProfile(selected);
    }
    exhaustWave(events, sharpness) {
      // One 720-degree cycle: uneven V8 bank firing gives the low idle burble.
      const samples = 512, harmonics = 64, pulse = new Float32Array(samples);
      for (let i = 0; i < samples; i++) {
        for (let j = 0; j < events.length; j++) {
          const phase = (i / samples - events[j] / 720 + 1) % 1;
          pulse[i] += Math.exp(-phase * sharpness) * (1 - Math.exp(-phase * 650)) *
            (1 + 0.3 * Math.cos(phase * 110)) * (1 + (j % 3 - 1) * 0.06);
        }
      }
      const real = new Float32Array(harmonics + 1), imag = new Float32Array(harmonics + 1);
      for (let h = 1; h <= harmonics; h++) {
        for (let i = 0; i < samples; i++) {
          const angle = 2 * Math.PI * h * i / samples;
          real[h] += pulse[i] * Math.cos(angle) * 2 / samples;
          imag[h] += pulse[i] * Math.sin(angle) * 2 / samples;
        }
      }
      return this.context.createPeriodicWave(real, imag);
    }
    setProfile(id) {
      const t = this.context.currentTime;
      for (const voice of this.voices) {
        voice.gain.gain.cancelScheduledValues(t); voice.gain.gain.setTargetAtTime(0, t, 0.025);
        voice.osc.stop(t + 0.2);
        voice.osc.onended = () => { voice.osc.disconnect(); voice.gain.disconnect(); };
      }
      if (this.noiseSource) {
        const source = this.noiseSource, filter = this.noiseFilter, gain = this.noiseGain;
        gain.gain.cancelScheduledValues(t); gain.gain.setTargetAtTime(0, t, 0.025);
        source.stop(t + 0.2); source.onended = () => { source.disconnect(); filter.disconnect(); gain.disconnect(); };
      }
      this.voices = [];
      const banks = id === 'muscle' ? [[0, 90, 270, 540], [180, 360, 450, 630]] :
        [[0, 144, 288, 432, 576], [72, 216, 360, 504, 648]];
      const specs = id === 'future' ? [[1, 0.36, 'sine'], [2.01, 0.16, 'sine'], [4.005, 0.06, 'sine']] :
        [[1, 0.34, 'bank'], [1, 0.30, 'bank'], [2, 0.08, 'sine'], [profiles[id].cylinders, 0.05, 'triangle']];
      this.body.frequency.setTargetAtTime(id === 'muscle' ? 115 : 210, t, 0.1);
      this.body.gain.setTargetAtTime(id === 'muscle' ? 4 : 2, t, 0.1);
      for (const [index, [ratio, level, type]] of specs.entries()) {
        const osc = this.context.createOscillator(), gain = this.context.createGain();
        if (type === 'bank') osc.setPeriodicWave(this.exhaustWave(banks[index], id === 'muscle' ? 48 : 75));
        else osc.type = type;
        gain.gain.value = 0; osc.frequency.value = 50;
        osc.connect(gain); gain.connect(id === 'future' ? this.bus : this.drive); osc.start(t);
        this.voices.push({ osc, gain, ratio, level, bank: type === 'bank' });
      }
      this.noiseSource = this.context.createBufferSource(); this.noiseSource.buffer = this.noise; this.noiseSource.loop = true;
      this.noiseGain = this.context.createGain(); this.noiseGain.gain.value = 0;
      this.noiseFilter = this.context.createBiquadFilter(); this.noiseFilter.type = 'bandpass'; this.noiseFilter.frequency.value = 550; this.noiseFilter.Q.value = 0.7;
      this.noiseSource.connect(this.noiseFilter); this.noiseFilter.connect(this.noiseGain); this.noiseGain.connect(this.bus); this.noiseSource.start(t);
    }
    update(state) {
      const t = this.context.currentTime, p = profiles[selected];
      const relative = clamp((state.rpm - p.idle) / (p.redline - p.idle), 0, 1);
      const force = intensity / 100, load = state.throttle;
      const base = selected === 'future' ? 65 + state.rpm * 0.025 : state.rpm / 120;
      const flutter = 1 + (Math.sin(t * 11.3) * 0.005 + Math.sin(t * 17.9) * 0.003) * (1 - relative) ** 2;
      for (const v of this.voices) {
        v.osc.frequency.setTargetAtTime(base * v.ratio * flutter, t, 0.035);
        v.gain.gain.setTargetAtTime(v.level * (0.38 + load * 0.5 + relative * 0.12) * (v.bank ? 1 + Math.sin(t * 9.7) * 0.055 * (1 - relative) : 1) * (state.shifting ? 0.32 : 1), t, 0.04);
      }
      this.noiseGain.gain.setTargetAtTime(selected === 'future' ? 0.07 + load * 0.05 : (0.015 + load * force * 0.11 + relative * 0.025) * (state.shifting ? 0.3 : 1), t, 0.06);
      this.noiseFilter.frequency.setTargetAtTime(500 + relative * 1800 + load * 700, t, 0.08);
      this.filter.frequency.setTargetAtTime(selected === 'future' ? 1800 + relative * 5000 : 420 + relative * 2100 + load * (700 + force * 2100), t, 0.08);
      this.drive.gain.setTargetAtTime(0.8 + load * (0.5 + force * 0.8), t, 0.06);
      const target = running && document.visibilityState === 'visible' && !audioRecovery ? Math.pow(volume / 100, 1.6) * 0.65 : 0;
      this.master.gain.setTargetAtTime(target, t, 0.07);
    }
    shift() {
      if (!shiftsEnabled || !running || selected === 'future') return;
      const t = this.context.currentTime, src = this.context.createBufferSource(), gain = this.context.createGain();
      const filter = this.context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 650;
      src.buffer = this.noise; gain.gain.setValueAtTime(0.07 * intensity / 100, t); gain.gain.exponentialRampToValueAtTime(0.001, t + 0.13);
      src.connect(filter); filter.connect(gain); gain.connect(this.limiter); src.start(); src.stop(t + 0.15);
      src.onended = () => { src.disconnect(); filter.disconnect(); gain.disconnect(); };
      const knock = this.context.createOscillator(), envelope = this.context.createGain();
      knock.frequency.setValueAtTime(selected === 'muscle' ? 120 : 180, t);
      knock.frequency.exponentialRampToValueAtTime(45, t + 0.09);
      envelope.gain.setValueAtTime(0, t); envelope.gain.linearRampToValueAtTime(0.1 * intensity / 100, t + 0.006);
      envelope.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
      knock.connect(envelope); envelope.connect(this.limiter); knock.start(t); knock.stop(t + 0.12);
      knock.onended = () => { knock.disconnect(); envelope.disconnect(); };
    }
    mute() { this.master.gain.setTargetAtTime(0, this.context.currentTime, 0.04); }
  }

  function stopGps(reset = true) {
    if (watchId !== null && navigator.geolocation) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (reset) { anchor = null; gpsRaw = null; gpsReceived = null; gpsAccuracy = null; gpsFiltered = 0; gpsAcceleration = 0; gpsRejects = 0; }
  }
  function distance(a, b) {
    const r = Math.PI / 180, dlat = (b.latitude - a.latitude) * r, dlon = (b.longitude - a.longitude) * r;
    const h = Math.sin(dlat / 2) ** 2 + Math.cos(a.latitude * r) * Math.cos(b.latitude * r) * Math.sin(dlon / 2) ** 2;
    return 6371008.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function startGps() {
    stopGps(); gpsState = 'waiting';
    if (!window.isSecureContext) { gpsState = 'error'; notice('GPS 需要 HTTPS，请通过正式网址打开。'); return; }
    if (!navigator.geolocation) { gpsState = 'error'; notice('浏览器不支持定位，可使用演示模式。'); return; }
    const generation = runGeneration;
    notice('请允许位置访问；等待有效车速…');
    watchId = navigator.geolocation.watchPosition(position => {
      if (!running || mode !== 'gps' || generation !== runGeneration) return;
      const c = position.coords, now = performance.now(), timestamp = position.timestamp;
      if (![c.latitude, c.longitude, c.accuracy, timestamp].every(Number.isFinite) || c.accuracy < 0) return;
      gpsAccuracy = c.accuracy;
      if (c.accuracy > 100) { gpsState = 'poor'; notice('定位精度较低，暂不使用这次测量。'); return; }
      if (anchor && timestamp <= anchor.timestamp) return;
      let measured = Number.isFinite(c.speed) && c.speed >= 0 ? c.speed : null;
      const next = { latitude: c.latitude, longitude: c.longitude, accuracy: c.accuracy, timestamp };
      if (measured === null) {
        if (c.accuracy > 50) { gpsState = 'poor'; return; }
        if (!anchor) { anchor = next; gpsState = 'waiting'; return; }
        const dt = (timestamp - anchor.timestamp) / 1000, moved = distance(anchor, next);
        if (dt > 15) { anchor = next; return; }
        if (moved < Math.max(3, (anchor.accuracy + c.accuracy) * 0.75)) {
          if (dt < 4) return;
          measured = 0;
        } else measured = moved / Math.max(dt, 0.2);
      }
      if (measured > 85) return;
      const dt = gpsReceived === null ? null : (now - gpsReceived) / 1000;
      if (dt && dt < 10 && Math.abs(measured - gpsRaw) / dt > 10 && ++gpsRejects <= 3) return;
      gpsRejects = 0; anchor = next;
      if (dt === null || dt > 10) { gpsFiltered = measured; gpsAcceleration = 0; }
      else { const old = gpsFiltered; gpsFiltered += smooth(dt, 0.8) * (measured - gpsFiltered); gpsAcceleration += smooth(dt, 1) * (clamp((gpsFiltered - old) / Math.max(dt, 0.1), -8, 8) - gpsAcceleration); }
      gpsRaw = measured; gpsReceived = now; gpsState = 'fresh'; notice('GPS 跟随中 · 定位由本机处理');
    }, error => {
      if (!running || mode !== 'gps' || generation !== runGeneration) return;
      gpsState = 'error';
      notice(error.code === 1 ? '定位未获允许。可在浏览器设置中授权，或切换演示模式。' : error.code === 2 ? '暂时没有定位信号，请在开阔处重新获取。' : '定位等待超时，可重新获取或使用演示模式。');
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
  }

  function resetPowertrain() { gear = 0; gearAge = 0; shiftUntil = 0; rpm = profiles[selected].idle; throttle = 0; }
  function setMode(next) {
    mode = next; autoDemo = false; demoTime = 0; speed = 0; accel = 0; runGeneration++;
    stopGps(); resetPowertrain();
    $('demo-mode').classList.toggle('active', mode === 'demo'); $('gps-mode').classList.toggle('active', mode === 'gps');
    $('demo-mode').setAttribute('aria-pressed', mode === 'demo'); $('gps-mode').setAttribute('aria-pressed', mode === 'gps');
    $('demo-controls').hidden = mode !== 'demo'; $('gps-controls').hidden = mode !== 'gps';
    $('auto-demo').setAttribute('aria-pressed', 'false'); $('auto-demo').textContent = '自动巡航演示';
    $('mode-caption').textContent = mode === 'gps' ? 'GPS 车速' : '演示车速';
    if (running && mode === 'gps') startGps();
    else notice(mode === 'gps' ? '点击启动引擎，允许位置访问' : '演示模式 · 可拖动车速或开启自动巡航');
  }
  async function stop() {
    running = false; starting = false; runGeneration++; stopGps(); autoDemo = false; audioRecovery = false; speed = 0; accel = 0; throttle = 0;
    if (audio) audio.mute();
    if (wakeLock) { try { await wakeLock.release(); } catch (_) {} wakeLock = null; }
    $('auto-demo').setAttribute('aria-pressed', 'false'); $('auto-demo').textContent = '自动巡航演示';
    updateWakeLabel(); notice('引擎已停止'); paint(performance.now());
  }
  async function start() {
    if (running && !audioRecovery) { await stop(); return; }
    if (starting) return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) { notice('浏览器不支持 Web Audio，无法生成声音。'); return; }
    starting = true; $('start').disabled = true;
    try {
      if (!audio) {
        let context;
        try { context = new Ctx({ latencyHint: 'interactive' }); } catch (_) { context = new Ctx(); }
        await context.resume(); audio = new Synth(context);
        context.onstatechange = () => { if (running && context.state !== 'running') { audioRecovery = true; notice('音频已暂停，请点击恢复声音。'); } };
      } else await audio.context.resume();
      if (audio.context.state !== 'running') throw new Error('audio-suspended');
      audioRecovery = false; running = true; runGeneration++; resetPowertrain(); lastFrame = performance.now();
      if (mode === 'gps') startGps(); else notice('演示模式 · 拖动车速或开启自动巡航');
      if (wakeWanted) await acquireWake();
    } catch (_) { running = false; notice('声音未能启动，请再次点击；车机可能限制网页音频。'); }
    finally { starting = false; $('start').disabled = false; paint(performance.now()); }
  }

  function updatePowertrain(dt, now) {
    const p = profiles[selected]; gearAge += dt;
    const targetThrottle = speed < 0.3 ? 0 : clamp((accel + 0.18 + speed * speed * 0.00035) / Math.max(1.2, 5.5 - speed * 0.065), 0, 1);
    throttle += smooth(dt, 0.3) * (targetThrottle - throttle);
    const inGear = g => speed / p.tire * 60 * p.ratios[g] * p.final;
    if (speed < 0.4) gear = 0;
    if (now > shiftUntil && p.ratios.length > 1 && gearAge > 0.8) {
      const current = inGear(gear), threshold = p.cruise + (p.shift - p.cruise) * Math.pow(throttle, 1.3);
      let next = gear;
      if (gear < p.ratios.length - 1 && current > threshold && gearAge > 1.1) next++;
      else if (gear > 0 && (current < p.idle * 1.4 || (throttle > 0.7 && current < p.shift * 0.45)) && inGear(gear - 1) < p.shift * 0.85) next--;
      if (next !== gear) { gear = next; gearAge = 0; shiftUntil = now + 300; if (audio) audio.shift(); }
    }
    const target = clamp(Math.max(p.idle, inGear(gear), p.idle + throttle * 1400 * clamp(1 - speed / 6, 0, 1)), p.idle, p.redline);
    rpm += smooth(dt, now < shiftUntil ? 0.14 : 0.07) * (target - rpm);
    if (audio) audio.update({ rpm, throttle, shifting: now < shiftUntil });
  }
  function demoTarget() {
    if (!autoDemo) return Number($('demo-speed').value) / 3.6;
    const t = demoTime % 36;
    return (t < 2 ? 0 : t < 15 ? (t - 2) / 13 * 135 : t < 19 ? 135 : t < 33 ? 135 * (1 - (t - 19) / 14) : 0) / 3.6;
  }
  function frame(now) {
    const gap = (now - lastFrame) / 1000, dt = clamp(gap, 0, 0.1); lastFrame = now;
    if (running && document.visibilityState === 'visible' && !audioRecovery) {
      if (gap > 2) { accel = 0; resetPowertrain(); }
      let target;
      if (mode === 'demo') { demoTime += dt; target = demoTarget(); }
      else {
        const age = gpsReceived === null ? Infinity : (now - gpsReceived) / 1000;
        if (age > 8 && gpsReceived !== null) { gpsState = 'lost'; target = 0; accel = 0; }
        else { if (age > 3.5 && gpsReceived !== null) gpsState = 'stale'; target = gpsFiltered; }
      }
      const previous = speed;
      speed += smooth(dt, mode === 'gps' && gpsState === 'lost' ? 2 : 0.4) * (target - speed);
      if (speed < 0.01) speed = 0;
      const estimated = mode === 'gps' && gpsState === 'fresh' ? gpsAcceleration : (speed - previous) / Math.max(dt, 0.001);
      accel += smooth(dt, 0.3) * (estimated - accel);
      updatePowertrain(dt, now);
    }
    if (now - lastPaint > 100) { paint(now); lastPaint = now; }
    requestAnimationFrame(frame);
  }
  function paint(now) {
    const active = running && !audioRecovery;
    // A lost fix remains visible as last measured speed, while sound fades toward idle.
    const displaySpeed = mode === 'gps' && gpsState === 'lost' && gpsRaw !== null ? gpsFiltered : speed;
    $('speed').textContent = Math.round(displaySpeed * 3.6);
    $('gauge').style.setProperty('--angle', clamp(displaySpeed * 3.6 / 200, 0, 1) * 270 + 'deg');
    $('rpm').textContent = active ? Math.round(rpm / 10) * 10 : '—';
    $('rpm-fill').style.width = active ? clamp(rpm / 9000 * 100, 0, 100) + '%' : '0%';
    $('gear').textContent = active && speed > 0.3 ? gear + 1 : 'N';
    $('throttle').textContent = active ? Math.round(throttle * 100) + '%' : '—';
    $('accuracy').textContent = mode === 'gps' && gpsAccuracy !== null ? '±' + Math.round(gpsAccuracy) + ' m' : '—';
    const status = !running ? (mode === 'demo' ? '演示就绪' : '等待启动') : mode === 'demo' ? '模拟输入' : ({ waiting: '等待定位', fresh: '定位正常', stale: '数据延迟', lost: '信号丢失', poor: '精度较低', error: '定位不可用' }[gpsState] || '等待定位');
    $('data-status').textContent = status;
    $('shift-label').textContent = mode === 'gps' && gpsState === 'lost' ? '末次车速 · 声音回落' : now < shiftUntil && active ? '换挡中' : '模拟动力系统';
    $('motion-label').textContent = !active ? 'READY TO DRIVE' : selected === 'future' ? 'ELECTRIC FLOW' : accel > 0.3 ? 'ACCELERATING' : accel < -0.3 ? 'COASTING' : 'CRUISING';
    $('start-label').textContent = audioRecovery && running ? '恢复声音' : running ? '停止引擎' : '启动引擎';
    $('start').classList.toggle('running', running);
    $('audio-status').classList.toggle('running', active && document.visibilityState === 'visible');
    $('audio-status').innerHTML = '<i></i>' + (audioRecovery ? '声音已暂停' : running ? (document.visibilityState === 'visible' ? '引擎运行' : '后台暂停') : '引擎待机');
  }
  function rangePaint(element) { element.style.setProperty('--fill', (Number(element.value) - Number(element.min)) / (Number(element.max) - Number(element.min)) * 100 + '%'); }
  function profilePaint() { document.querySelectorAll('.profile').forEach(button => { const yes = button.dataset.profile === selected; button.classList.toggle('selected', yes); button.setAttribute('aria-pressed', String(yes)); }); }
  function updateWakeLabel() { $('wake-lock').setAttribute('aria-pressed', String(!!wakeLock)); $('wake-lock').innerHTML = (wakeLock ? '屏幕常亮已开启' : '保持屏幕常亮') + ' <span>↗</span>'; }
  async function acquireWake() {
    if (!('wakeLock' in navigator)) { notice('当前浏览器不支持屏幕常亮，请保持页面前台。'); return; }
    if (wakeLock || document.visibilityState !== 'visible') return;
    try { const lock = await navigator.wakeLock.request('screen'); wakeLock = lock; lock.addEventListener('release', () => { if (wakeLock === lock) wakeLock = null; updateWakeLabel(); }); }
    catch (_) { notice('屏幕常亮未能开启，系统可能限制此功能。'); }
    updateWakeLabel();
  }
  $('start').addEventListener('click', start);
  $('demo-mode').addEventListener('click', () => setMode('demo'));
  $('gps-mode').addEventListener('click', () => setMode('gps'));
  $('retry-gps').addEventListener('click', () => { if (running) { runGeneration++; startGps(); } else notice('请先点击启动引擎。'); });
  $('auto-demo').addEventListener('click', async () => {
    if (!running) { await start(); if (!running) return; }
    autoDemo = !autoDemo; demoTime = 0;
    $('auto-demo').setAttribute('aria-pressed', String(autoDemo)); $('auto-demo').textContent = autoDemo ? '停止自动演示' : '自动巡航演示';
  });
  $('demo-speed').addEventListener('input', e => { autoDemo = false; $('auto-demo').setAttribute('aria-pressed', 'false'); $('auto-demo').textContent = '自动巡航演示'; $('demo-value').textContent = e.target.value + ' km/h'; rangePaint(e.target); });
  $('volume').addEventListener('input', e => { volume = Number(e.target.value); $('volume-value').textContent = volume + '%'; rangePaint(e.target); saveSettings(); });
  $('intensity').addEventListener('input', e => { intensity = Number(e.target.value); $('intensity-value').textContent = intensity + '%'; rangePaint(e.target); saveSettings(); });
  $('shift-sound').addEventListener('change', e => { shiftsEnabled = e.target.checked; saveSettings(); });
  document.querySelectorAll('.profile').forEach(button => button.addEventListener('click', () => { selected = button.dataset.profile; resetPowertrain(); if (audio) audio.setProfile(selected); profilePaint(); saveSettings(); }));
  $('help-toggle').addEventListener('click', () => { $('help-panel').hidden = !$('help-panel').hidden; $('help-toggle').setAttribute('aria-expanded', String(!$('help-panel').hidden)); });
  $('wake-lock').addEventListener('click', async () => { if (wakeLock) { wakeWanted = false; await wakeLock.release(); wakeLock = null; updateWakeLabel(); } else { wakeWanted = true; await acquireWake(); } });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') { if (audio) audio.mute(); }
    else { lastFrame = performance.now(); if (running) { audioRecovery = true; notice('页面已恢复，请点击「恢复声音」继续。'); } if (wakeWanted && running) acquireWake(); }
  });
  window.addEventListener('pagehide', () => { runGeneration++; running = false; stopGps(); if (audio) audio.mute(); });
  loadSettings(); profilePaint();
  $('volume-value').textContent = volume + '%'; $('intensity-value').textContent = intensity + '%';
  ['volume', 'intensity', 'demo-speed'].forEach(id => rangePaint($(id)));
  paint(performance.now()); requestAnimationFrame(frame);
})();
