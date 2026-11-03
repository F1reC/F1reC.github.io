import { createLake } from './lake.js'
import { YEAR_SECONDS, seasonAt, subseasonAt, SUBSEASONS, LINES, RETURN_LINE } from './seasons.js'

// ---------------------------------------------------------------- content
// 整站只放一首歌，循环播放。音频文件放在 music/ 下，文件名和这里一致
// peaks 是提前算好的 88 根波形柱高度（换歌时要重新算），打开波形面板时直接画，不用先下载、解码整首歌
const TRACK = {
  title: 'Cloud Atlas End Title', artist: 'Tom Tykwer', year: 2012, src: 'music/cloud-atlas-end-title.m4a',
  peaks: [0.064, 0.064, 0.06, 0.06, 0.069, 0.06, 0.06, 0.06, 0.06, 0.06, 0.07, 0.06, 0.06, 0.061, 0.06, 0.06, 0.06, 0.061, 0.083, 0.074, 0.063, 0.065, 0.099, 0.095, 0.121, 0.129, 0.112, 0.109, 0.147, 0.171, 0.151, 0.154, 0.224, 0.235, 0.181, 0.162, 0.177, 0.172, 0.175, 0.18, 0.185, 0.299, 0.254, 0.249, 0.303, 0.284, 0.265, 0.269, 0.229, 0.278, 0.27, 0.366, 0.456, 0.408, 0.404, 0.378, 0.383, 0.348, 0.519, 0.566, 0.557, 0.459, 0.48, 0.525, 0.512, 0.549, 0.503, 0.505, 0.57, 0.682, 0.833, 0.754, 0.926, 0.941, 1, 0.825, 0.868, 0.866, 0.933, 0.978, 1, 1, 0.981, 0.858, 1, 1, 1, 0.077],
}

const SCENE_KEY = 'seasons.scene-cycle.v1'
// The horizon view: the seasons show most on the mountains and forest.
const SCENES = [{ view: 'vast', seed: 0 }]
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
const fine = matchMedia('(pointer: fine)').matches

const $ = (s) => document.querySelector(s)
const html = document.documentElement
const lakeEl = $('.lake')
const ui = $('#interface')
const clamp = (x, a, b) => Math.min(b, Math.max(a, x))
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t) }
const wrap = (m) => ((m % 1440) + 1440) % 1440

// ---------------------------------------------------------------- scene bag (every scene before a repeat)

function readBag() {
  try {
    const s = JSON.parse(sessionStorage.getItem(SCENE_KEY) || 'null')
    return s && Array.isArray(s.remaining) ? s : { remaining: [], last: -1 }
  } catch { return { remaining: [], last: -1 } }
}

function nextScene() {
  const bag = readBag()
  let rem = bag.remaining.filter((i) => Number.isInteger(i) && i >= 0 && i < SCENES.length)
  if (!rem.length) {
    rem = SCENES.map((_, i) => i).sort(() => Math.random() - 0.5)
    if (rem[0] === bag.last) rem.push(rem.shift())
  }
  const [cur, ...rest] = rem
  try { sessionStorage.setItem(SCENE_KEY, JSON.stringify({ remaining: rest, last: cur })) } catch {}
  return SCENES[cur]
}

// ---------------------------------------------------------------- audio

const A = { ctx: null }

// Real recordings (CC0, BigSoundBank), processed in sfx/. Decoded once, played through WebAudio.
const SFX = {
  tick: 'sfx/tick.mp3',
  drops: [1, 2, 3, 4, 5].map((i) => `sfx/drop${i}.mp3`),
  swishes: [1, 2, 3, 4, 5].map((i) => `sfx/swish${i}.mp3`),
  water: 'sfx/water-loop.mp3',
  insects: 'sfx/night-insects.mp3',
  birds: 'sfx/morning-birds.mp3',
  rain: 'sfx/spring-rain.mp3',
  cicadas: 'sfx/summer-cicadas.mp3',
  autumnWind: 'sfx/autumn-wind.mp3',
  winterWind: 'sfx/winter-wind.mp3',
  bowls: ['sfx/bowl1.mp3', 'sfx/bowl2.mp3'],
}
const buffers = new Map()

async function loadBuffer(url) {
  if (!buffers.has(url)) buffers.set(url, fetch(url).then((r) => r.arrayBuffer()).then((b) => A.ctx.decodeAudioData(b)).catch(() => null))
  return buffers.get(url)
}

// Shuffle bag: every sample plays before any repeats, never the same one twice in a row.
function bag(list) {
  let pool = [], last = null
  return () => {
    if (!pool.length) { pool = [...list].sort(() => Math.random() - 0.5); if (pool[0] === last && pool.length > 1) pool.push(pool.shift()) }
    return (last = pool.shift())
  }
}
const nextDrop = bag(SFX.drops)
const nextSwish = bag(SFX.swishes)

async function oneShot(url, gain, { rate = 1, lowpass = 20000, pan = 0 } = {}) {
  const ctx = A.ctx
  if (!ctx) return
  const buf = await loadBuffer(url)
  if (!buf) return
  const src = ctx.createBufferSource()
  src.buffer = buf
  src.playbackRate.value = rate
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = lowpass
  const g = ctx.createGain(); g.gain.value = gain
  const p = ctx.createStereoPanner(); p.pan.value = pan
  src.connect(lp).connect(g).connect(p).connect(A.out)
  src.start()
}

async function bed(url) {
  const ctx = A.ctx
  const g = ctx.createGain(); g.gain.value = 0; g.connect(A.out)
  const buf = await loadBuffer(url)
  if (buf) { const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true; src.connect(g); src.start() }
  return g
}

function unlockAudio() {
  if (A.ctx) return A.ctx.state === 'suspended' && A.ctx.resume()
  const ctx = new (window.AudioContext || window.webkitAudioContext)()
  A.ctx = ctx
  A.out = ctx.createDynamicsCompressor()
  A.out.threshold.value = -2
  A.out.ratio.value = 20
  A.out.connect(ctx.destination)
  ;[SFX.tick, ...SFX.drops, ...SFX.swishes].forEach(loadBuffer)
  SFX.bowls.forEach(loadBuffer)
  Promise.all([SFX.water, SFX.insects, SFX.birds, SFX.rain, SFX.cicadas, SFX.autumnWind, SFX.winterWind].map(bed)).then(([w, i, b, r, c, aw, ww]) => {
    Object.assign(A, { water: w, insects: i, birds: b, rain: r, cicadas: c, autumnWind: aw, winterWind: ww })
    w.gain.setTargetAtTime(ambienceLevel(), ctx.currentTime, 1.6) // ~5 s fade-in
    updateAmbience(minutesNow(), true)
  })
  startMusic() // 浏览器只允许在用户第一次点击或按键之后出声，所以歌从这里开始放
}

// The lake gets louder with the afternoon breeze.
function ambienceLevel() {
  const b = lake ? lake.breeze : 40
  return 0.8 * (0.36 + 0.64 * Math.pow(smooth(0.34, 1, Math.min(1, b / 88)), 0.82))
}

// Each season has its own bed: rain and birds in spring, cicadas in summer, wind through the larches in
// autumn, and a thin wind over near silence in winter. Crickets sing on warm nights.
// 放歌时背景音整体让一点（约 -2 dB），让音乐和湖声平衡
const ambDuck = () => (playing ? 0.8 : 1)

function updateAmbience(minutes, now = false) {
  if (!A.water) return
  const st = seasonAt(minutes / 1440), [sp, su, au, wi] = st.weights
  const h = ((st.hours % 24) + 24) % 24
  const day = smooth(6, 8, h) * (1 - smooth(19, 21, h))
  const t = A.ctx.currentTime, tc = now ? 0.01 : 1.2, k = ambDuck()
  A.water.gain.setTargetAtTime(ambienceLevel() * (1 - 0.45 * wi) * k, t, tc)
  A.rain.gain.setTargetAtTime(Math.min(1, st.rain * 1.2) * k, t, tc)
  A.birds.gain.setTargetAtTime((sp + 0.4 * su) * day * 0.75 * (1 - st.rain * 0.6) * k, t, tc)
  A.cicadas.gain.setTargetAtTime(su * day * 0.7 * k, t, tc)
  A.insects.gain.setTargetAtTime((1 - day) * (su + 0.5 * sp + 0.3 * au) * 0.8 * k, t, tc)
  A.autumnWind.gain.setTargetAtTime(au * 0.75 * k, t, tc)
  A.winterWind.gain.setTargetAtTime(wi * 0.6 * k, t, tc)
}

// A singing bowl, far off, marks each turn of the season.
let bowlIndex = 0
function bowl() {
  oneShot(SFX.bowls[bowlIndex++ % SFX.bowls.length], 0.32, { lowpass: 4500, pan: 0.25 })
}

// Touching the water stirs the lake: the ambience swells for a couple of seconds, then settles.
let swellTimer = 0
function swell() {
  if (!A.water) return
  const t = A.ctx.currentTime
  A.water.gain.cancelScheduledValues(t)
  A.water.gain.setTargetAtTime(ambienceLevel() * 1.45 * ambDuck(), t, 0.25)
  clearTimeout(swellTimer)
  swellTimer = setTimeout(() => A.water.gain.setTargetAtTime(ambienceLevel() * ambDuck(), A.ctx.currentTime, 0.8), 2200)
}

// The dial's click: one recorded mechanical tick per half hour crossed.
function tick() {
  oneShot(SFX.tick, 0.09) // matches the original's level (-12.5 dBFS sample at gain .24)
}

// A stone into the pond. Near drops are louder and brighter; far ones are muffled.
function splashSound(near, strength = 1) {
  if (near < 0.065) return
  const gain = Math.min(1, (0.15 + 0.9 * Math.pow(near, 1.2)) * strength)
  swell()
  oneShot(nextDrop(), gain, { rate: 0.94 + Math.random() * 0.12, lowpass: 1800 + near * 14000, pan: (Math.random() - 0.5) * 0.3 })
}

// A hand or oar sweeping through the water, gated like the original: long enough, fast enough.
let lastSwish = 0
function swishSound(speedPx, near, pan) {
  const t = performance.now()
  if (t - lastSwish < 420 || speedPx < 0.21) return
  lastSwish = t
  const gain = Math.min(0.9, 0.26 + speedPx * 0.2) * (0.45 + 0.55 * near)
  swell()
  oneShot(nextSwish(), gain, { rate: 0.9 + Math.min(0.25, speedPx * 0.05), lowpass: 1500 + near * 9000, pan })
}

// 音乐：保留原曲的立体声，不再放到“湖对岸”的单点声源上（那样会发闷、发窄）。
// 干声直出，再加一路宽的混响，让音乐和湖声处在同一个空间里。
function musicChain() {
  if (A.music) return A.music
  const ctx = A.ctx
  const el = new Audio()
  el.crossOrigin = 'anonymous'
  el.preload = 'auto'
  el.loop = true
  const src = ctx.createMediaElementSource(el)
  const low = ctx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 140; low.gain.value = 1.5
  const air = ctx.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = 7000; air.gain.value = 1.5
  const dry = ctx.createGain(); dry.gain.value = 0.9
  // 立体声混响：左右声道用不同的噪声衰减，空间更宽
  const verb = ctx.createConvolver()
  const len = ctx.sampleRate * 3.2, ir = ctx.createBuffer(2, len, ctx.sampleRate)
  for (let c = 0; c < 2; c++) ir.getChannelData(c).forEach((_, i, a) => { a[i] = (Math.random() * 2 - 1) * Math.exp((-3.8 * i) / len) })
  verb.buffer = ir
  const verbIn = ctx.createBiquadFilter(); verbIn.type = 'highpass'; verbIn.frequency.value = 250 // 混响里去掉低频，免得糊
  const wet = ctx.createGain(); wet.gain.value = 0.28
  const vol = ctx.createGain(); vol.gain.value = 0
  src.connect(low).connect(air)
  air.connect(dry).connect(vol)
  air.connect(verbIn).connect(verb).connect(wet).connect(vol)
  vol.connect(A.out)
  A.music = { el, vol }
  return A.music
}

// ---------------------------------------------------------------- time

let lake = null
let offset = null // custom time = real time + offset (minutes); advances with the clock
let timeAnim = null
// The dial's 1440 "minutes" are one year; it starts at the first thaw and advances on its own.
const T0 = performance.now()
const realMinutes = () => 0.012 * 1440 + ((performance.now() - T0) / 1000) * (1440 / YEAR_SECONDS)
const minutesNow = () => wrap(realMinutes() + (offset ?? 0))
const shortest = (d) => ((((d + 720) % 1440) + 1440) % 1440) - 720

let lastUserSet = -1e9
function setCustom(min) { offset = shortest(min - realMinutes()); timeAnim = null; lastUserSet = performance.now() }

function animateTo(target, clearAfter) {
  const from = minutesNow(), delta = shortest(target - from)
  const dur = reduced ? 300 : 380 + (Math.abs(delta) / 720) * 520
  timeAnim = { from, delta, t0: performance.now(), dur, clearAfter }
}

function fmt(min) {
  return { num: subseasonAt(wrap(min) / 1440), mer: '' }
}

let lastLabel = ''
let lastTickSlot = null
function renderTime(min) {
  const { num, mer } = fmt(min)
  const label = num + mer
  if (label !== lastLabel) {
    lastLabel = label
    $('#time-numerals').textContent = num
    $('#time-meridiem').textContent = mer
    $('#slider-numerals').textContent = num
    $('#slider-meridiem').textContent = ''
    $('#time-drag').setAttribute('aria-valuenow', Math.floor(min))
    $('#time-drag').setAttribute('aria-valuetext', num)
  }
  const slot = Math.floor(min / 30)
  if (lastTickSlot !== null && slot !== lastTickSlot && (performance.now() - lastUserSet < 250 || timeAnim)) tick() // only when someone turns the dial
  lastTickSlot = slot
}

// Favicon: a small disc of the current sky.
const FAV = [
  [0, '#03070f', '#0b1622', '#c5bfac', 0.05],
  [5.5, '#050c14', '#17252a', '#d0a57f', 0.06],
  [7.5, '#0e2a36', '#2f5561', '#dcc5a4', 0.09],
  [12.5, '#0a3a58', '#347fa6', '#f8f5e5', 0.14],
  [17.5, '#1e2f33', '#46423a', '#e1a55b', 0.11],
  [19.5, '#130e0e', '#402a1c', '#e27a33', 0.14],
  [21, '#04080f', '#0e1a26', '#bcae95', 0.07],
  [24, '#03070f', '#0b1622', '#c5bfac', 0.05],
]
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
let favMinute = -1
function updateFavicon(min) {
  const m = Math.floor(min / 10) * 10 // min is time of day here
  if (m === favMinute) return
  favMinute = m
  const h = (((m / 60) % 24) + 24) % 24
  const i = FAV.findIndex((k, j) => j < FAV.length - 1 && h >= k[0] && h <= FAV[j + 1][0])
  const [a, b] = [FAV[i], FAV[i + 1]]
  const t = smooth(0, 1, (h - a[0]) / (b[0] - a[0]))
  const mix = (x, y) => { const p = hex(x), q = hex(y); return `rgb(${p.map((v, k) => Math.round(v + (q[k] - v) * t)).join(' ')})` }
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const x = c.getContext('2d')
  x.beginPath(); x.arc(32, 32, 30, 0, Math.PI * 2); x.clip()
  const g = x.createLinearGradient(0, 0, 0, 64)
  g.addColorStop(0, mix(a[1], b[1])); g.addColorStop(1, mix(a[2], b[2]))
  x.fillStyle = g; x.fillRect(0, 0, 64, 64)
  const glow = x.createRadialGradient(40, 14, 0, 40, 14, 34)
  const op = a[4] + (b[4] - a[4]) * t
  glow.addColorStop(0, mix(a[3], b[3]).replace(')', ` / ${Math.min(0.46, op * 2.15 + 0.1)})`))
  glow.addColorStop(1, 'rgb(255 255 255 / 0)')
  x.fillStyle = glow; x.fillRect(0, 0, 64, 64)
  $('#site-favicon').href = c.toDataURL('image/png')
}

// ---------------------------------------------------------------- views (resting / about / time / waveform)

let view = 'resting'
const VIEW_CLASS = { about: 'is-about-open', time: 'is-time-selected', waveform: 'is-waveform-open' }
const VIEW_EL = { about: '#about-panel', time: '#time-scrubber', waveform: '#track-waveform' }
const VIEW_TRIGGER = { about: '#site-title', time: '#time-button', waveform: '#track-title' }

function setView(next) {
  if (next === view) next = 'resting'
  const prev = view
  view = next
  ui.classList.toggle('is-resting', next === 'resting')
  for (const [k, cls] of Object.entries(VIEW_CLASS)) {
    const on = k === next
    ui.classList.toggle(cls, on)
    const el = $(VIEW_EL[k])
    el.setAttribute('aria-hidden', String(!on))
    el.inert = !on
    $(VIEW_TRIGGER[k]).setAttribute('aria-expanded', String(on))
  }
  if (next === 'about') { introShown = true; $('#about-panel').focus({ preventScroll: true }) }
  if (next === 'time') layoutTicks(minutesNow())
  if (next === 'waveform') drawWaveform(true)
  if (next === 'resting' && prev !== 'resting') $(VIEW_TRIGGER[prev]).focus({ preventScroll: true })
}

// ---------------------------------------------------------------- time dial

const ticksEl = $('#time-ticks')
const TICKS = Array.from({ length: 48 }, (_, i) => {
  const el = ticksEl.appendChild(document.createElement('span'))
  // 每个时节占 4 格：第一格是分界，第三格居中，挂上时节名
  if (i % 4 === 0) el.classList.add('is-major')
  if (i % 4 === 2) el.dataset.label = SUBSEASONS[i / 4 | 0]
  return el
})
let dialH = 378
let dialScale = 1

function measureDial() {
  const el = $('#time-scrubber')
  dialH = el.offsetHeight || 378
  dialScale = Math.min(358, innerWidth - 28) / 358
  el.style.setProperty('--active-w', `${(77 * 1.482 * dialScale * (innerWidth <= 700 ? 0.9 : 1)).toFixed(1)}px`)
}

// Ticks sit on a drum: evenly spaced in angle, so they bunch up toward the top and bottom.
function layoutTicks(min) {
  const cur = min / 30
  TICKS.forEach((el, i) => {
    let L = i - cur
    L = ((((L + 24) % 48) + 48) % 48) - 24
    const o = L / 12
    if (o < -1 || o >= 1) { el.style.opacity = 0; return }
    const s = (o * Math.PI) / 2
    const y = 0.5 + (o + (Math.sin(s) - o) * 0.46) * 0.5
    const d = Math.abs(y - 0.5) * 2
    const op = d > 0.54 ? 1 + (0.035 - 1) * smooth(0.54, 1, d) : 1
    el.style.transform = `translate(-50%, -50%) translateY(${(y * dialH).toFixed(2)}px)`
    el.style.opacity = (op * (i % 4 === 0 ? 1 : 0.55)).toFixed(3) // 时节分界的点亮一些
    // 离中线太近的时节名先隐去，免得和左边的当前时节重复
    if (el.dataset.label) el.style.setProperty('--lab', smooth(0.05, 0.2, d).toFixed(3))
  })
}

// Inverse of the drum curve: screen fraction → tick offset.
function dialOffsetAt(yFrac) {
  const target = (yFrac - 0.5) * 2
  let o = target
  for (let i = 0; i < 6; i++) {
    const f = 0.54 * o + 0.46 * Math.sin((o * Math.PI) / 2) - target
    const df = 0.54 + 0.46 * (Math.PI / 2) * Math.cos((o * Math.PI) / 2)
    o = clamp(o - f / df, -1, 1)
  }
  return o
}

let scrubbing = false
function bindDial() {
  const drag = $('#time-drag')
  const dial = $('#time-scrubber')
  let start = null
  const down = (e) => {
    e.preventDefault()
    e.target.setPointerCapture?.(e.pointerId)
    start = { y: e.clientY, min: minutesNow(), moved: false, rect: dial.getBoundingClientRect() }
  }
  const move = (e) => {
    if (!start) return
    const dy = e.clientY - start.y
    if (!start.moved && Math.abs(dy) < 3) return
    start.moved = true
    scrubbing = true
    dial.classList.add('is-dragging')
    setCustom(start.min - (dy / (dialH / 2)) * 360) // 抓着滚筒拖：往下拖，内容跟着往下，转出更早的时节
  }
  const up = (e) => {
    if (!start) return
    if (!start.moved && e.target === drag) {
      const o = dialOffsetAt((e.clientY - start.rect.top) / start.rect.height)
      animateTo(start.min + o * 360)
    }
    start = null
    scrubbing = false
    dial.classList.remove('is-dragging')
  }
  for (const el of [drag, $('#time-slider-value')]) {
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }
  addEventListener('wheel', (e) => {
    if (view !== 'time') return
    e.preventDefault()
    unlockAudio()
    const px = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * innerHeight : e.deltaY
    setCustom(minutesNow() + (px * 1440 / dialH) * 0.25 * 2) // same response as the original dial
  }, { passive: false })
}

// ---------------------------------------------------------------- music

let playing = false
let started = 0 // 开始放歌的时间；0 表示还没开始
const MUSIC_LEVEL = 0.6 // 原版是 0.38

function setPlaying(on) {
  playing = on
  updateAmbience(minutesNow())
  $('#track-title').classList.toggle('is-playing', on)
  $('#track-waveform').classList.toggle('is-paused', !on)
  $('#song-toggle').textContent = on ? '暂停' : '播放'
  const m = A.music
  if (!m) return
  const t = A.ctx.currentTime
  m.vol.gain.cancelScheduledValues(t)
  if (on) {
    m.vol.gain.setValueAtTime(m.vol.gain.value, t)
    m.vol.gain.linearRampToValueAtTime(MUSIC_LEVEL, t + 2.5) // 慢慢淡入，不吓人
    m.el.play().catch(() => setPlaying(false)) // 没放音频文件时，安静地停在“播放”
  } else {
    m.vol.gain.setValueAtTime(0, t)
    m.el.pause()
  }
}

function startMusic() {
  if (started) return
  started = performance.now()
  musicChain().el.src = TRACK.src
  setPlaying(true)
}

function togglePlay() {
  unlockAudio()
  if (!started) return startMusic()
  if (performance.now() - started < 400) return // 同一次点击刚刚开始放歌，别马上又暂停
  setPlaying(!playing)
}

// 波形面板（沿用原版）：左边作曲者，中间波形，右边歌名；点或拖波形可以跳到任意位置
const peaks = TRACK.peaks
let lastWave = 0
let seeking = false
function drawWaveform(force) {
  const now = performance.now()
  if (!force && now - lastWave < 50) return
  lastWave = now
  const c = $('#waveform-canvas')
  const dpr = devicePixelRatio || 1
  const H = c.offsetHeight || 104
  const W = peaks.length * 5
  if (c.width !== W * dpr) { c.width = W * dpr; c.height = H * dpr; c.style.width = `${W}px` }
  const x = c.getContext('2d')
  x.setTransform(dpr, 0, 0, dpr, 0, 0)
  x.clearRect(0, 0, W, H)
  x.lineWidth = 1.5
  x.lineCap = 'round'
  const el = A.music?.el
  // 拖动波形时，高亮跟着手走；松手后才真正跳过去
  const prog = seeking ? $('#waveform-range').value / 1000 : el && el.duration ? el.currentTime / el.duration : 0
  peaks.forEach((p, i) => {
    const h = Math.max(2, p * (H - 4))
    x.strokeStyle = `rgb(255 255 255 / ${0.5 + 0.5 * smooth(0, 1, prog * peaks.length - i)})`
    x.beginPath()
    x.moveTo(i * 5 + 2.5, (H - h) / 2)
    x.lineTo(i * 5 + 2.5, (H + h) / 2)
    x.stroke()
  })
  if (!seeking) $('#waveform-range').value = Math.round(prog * 1000)
  const r = $('#track-waveform').getBoundingClientRect()
  const a = $('#waveform-artist').offsetWidth, t = $('#waveform-title').offsetWidth
  $('#track-waveform').classList.toggle('is-metadata-hidden', r.left - 24 - a < 16 || r.right + 24 + t > innerWidth - 16)
}

function bindMusic() {
  $('#waveform-artist').textContent = TRACK.artist
  $('#waveform-title').textContent = TRACK.title
  $('#waveform-title').dataset.year = TRACK.year
  $('#track-title').addEventListener('click', () => setView('waveform'))
  // 点介绍下面的“暂停 / 播放”、歌名或作曲者都可以暂停 / 继续（空格键也可以）
  for (const id of ['#waveform-title', '#waveform-artist', '#song-toggle']) $(id).addEventListener('click', togglePlay)
  const range = $('#waveform-range')
  const fade = (v, s) => { const m = A.music; if (!m) return; const g = m.vol.gain, t = A.ctx.currentTime; g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.linearRampToValueAtTime(v, t + s) }
  range.addEventListener('pointerdown', () => { seeking = true; if (playing) fade(0, 0.16) })
  const release = () => { if (!seeking) return; seeking = false; if (playing) fade(MUSIC_LEVEL, 0.24) }
  range.addEventListener('pointerup', release)
  range.addEventListener('pointercancel', release)
  range.addEventListener('input', () => drawWaveform())
  range.addEventListener('change', () => {
    const el = A.music?.el
    if (el && el.duration) el.currentTime = (range.value / 1000) * el.duration
    seeking = false
    if (playing) fade(MUSIC_LEVEL, 0.24)
    drawWaveform(true)
  })
}

// ---------------------------------------------------------------- context menu

const menu = $('#context-links')
function openMenu(x, y) {
  menu.classList.add('is-open')
  lakeEl.classList.add('is-context-menu-open')
  menu.setAttribute('aria-hidden', 'false')
  ui.inert = true
  menu.querySelectorAll('a').forEach((a) => (a.tabIndex = 0))
  const w = menu.offsetWidth, h = menu.offsetHeight, first = $('#change-scene').offsetHeight
  menu.style.setProperty('--context-x', `${clamp(x - w + 3, 18, innerWidth - w - 18)}px`)
  menu.style.setProperty('--context-y', `${clamp(y - first / 2, 18, innerHeight - h - 18)}px`)
}
function closeMenu() {
  if (!menu.classList.contains('is-open')) return false
  menu.classList.remove('is-open')
  lakeEl.classList.remove('is-context-menu-open')
  menu.setAttribute('aria-hidden', 'true')
  ui.inert = false
  menu.querySelectorAll('a').forEach((a) => (a.tabIndex = -1))
  return true
}

// ---------------------------------------------------------------- pointer: cursor ring, drops, drags, backdrop scrub

const ring = $('#cursor-ring')
const ringPath = $('#cursor-path')

function drawRing(x, y) {
  const w = lake?.worldAt(x, y)
  if (!w) return false
  const a = clamp(y / innerHeight, 0, 1)
  const target = (8 + Math.pow(a, 1.1) * 18) * 4
  const pts = (R) => Array.from({ length: 64 }, (_, i) => {
    const t = (i / 64) * Math.PI * 2
    return lake.project(w[0] + Math.cos(t) * R, w[1] + Math.sin(t) * R)
  })
  let p = pts(0.1)
  if (p.some((q) => !q)) return false
  const width = Math.max(...p.map((q) => q[0])) - Math.min(...p.map((q) => q[0]))
  p = pts((0.1 * target) / Math.max(width, 1e-3))
  if (p.some((q) => !q)) return false
  const d = 'M' + p.map((q) => `${q[0].toFixed(1)},${q[1].toFixed(1)}`).join('L') + 'Z'
  ringPath.setAttribute('d', d)
  return true
}

function nearText(x, y) {
  for (const el of document.querySelectorAll('.cursor-text')) {
    if (!el.offsetParent || getComputedStyle(el).visibility === 'hidden') continue
    const op = parseFloat(getComputedStyle(el.closest('.control, .about-panel, .track-waveform, .time-scrubber, .context-links') || el).opacity)
    if (op < 0.05) continue
    const r = el.getBoundingClientRect()
    if (!r.width) continue
    const dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom)
    if (dx * dx + dy * dy < 400) return true
  }
  return false
}

let pointer = null // active press on the water or backdrop
let hover = { x: -1, y: -1 }
let suppressUntil = 0

// 天空上也用光斑，和湖面上的光标一致

function drawSkyDot(x, y) {
  const p = Array.from({ length: 32 }, (_, i) => {
    const t = (i / 32) * Math.PI * 2
    return `${(x + Math.cos(t) * 13).toFixed(1)},${(y + Math.sin(t) * 13).toFixed(1)}`
  })
  ringPath.setAttribute('d', 'M' + p.join('L') + 'Z')
}

function updateCursor(x, y) {
  if (!fine || !lake) return
  const overUi = document.elementFromPoint(x, y)?.closest('.control, .time-scrubber, .track-waveform, .about-panel, .context-links')
  const near = !overUi && nearText(x, y)
  lakeEl.classList.toggle('is-near-text', near)
  const onWater = !overUi && !near && drawRing(x, y)
  const overSky = !overUi && !near && !lake.worldAt(x, y)
  lakeEl.classList.toggle('is-over-backdrop', overSky)
  if (overSky) drawSkyDot(x, y)
  ring.classList.toggle('is-visible', (overSky || onWater) && !menu.classList.contains('is-open'))
}

// 每次打开网站：在湖面上点几下之后，自动展开自我介绍（一次访问只弹一次；自己点开过就不再弹）
// 不在连点的节奏里突然冒出来：等访客停手一会儿再慢慢浮现；浮现后的几秒里，点水面只起涟漪，不会把它点没
const INTRO_AFTER_TAPS = 3
const INTRO_QUIET_MS = 900
const INTRO_HOLD_MS = 4000
let waterTaps = 0
let introShown = false
let introTimer = 0
let introHoldUntil = 0
const introHeld = () => view === 'about' && performance.now() < introHoldUntil

function maybeShowIntro() {
  if (introShown || ++waterTaps < INTRO_AFTER_TAPS) return
  clearTimeout(introTimer) // 还在连点就继续等
  introTimer = setTimeout(() => {
    if (introShown || view !== 'resting') return
    introHoldUntil = performance.now() + INTRO_HOLD_MS
    ui.classList.add('is-gentle')
    setView('about')
    setTimeout(() => ui.classList.remove('is-gentle'), 2200)
  }, INTRO_QUIET_MS)
}

function bindPointer() {
  const canvas = $('#water')
  lakeEl.addEventListener('pointerdown', (e) => {
    unlockAudio()
    if (e.button !== 0) return
    if (e.target.closest('.context-links')) return
    if (closeMenu()) { suppressUntil = performance.now() + 400; return }
    if (e.target !== canvas) return
    if (view !== 'resting' && !introHeld()) {
      if (view === 'time' && e.pointerType !== 'mouse') {
        // touch: a vertical drag anywhere scrubs the dial
        pointer = { kind: 'dial-touch', y: e.clientY, min: minutesNow(), moved: false }
        return
      }
      setView('resting')
      return
    }
    const w = lake?.worldAt(e.clientX, e.clientY)
    if (!w) return // 天空上不再能拖动换季节
    canvas.setPointerCapture(e.pointerId)
    pointer = { kind: 'water', x: e.clientX, y: e.clientY, t: performance.now(), w, last: w, lastT: e.timeStamp, moved: false, touch: e.pointerType !== 'mouse' }
    ring.classList.add('is-pressed')
  })

  lakeEl.addEventListener('pointermove', (e) => {
    hover = { x: e.clientX, y: e.clientY }
    if (pointer?.kind === 'water') {
      const dx = e.clientX - pointer.x, dy = e.clientY - pointer.y
      if (!pointer.moved && Math.hypot(dx, dy) >= (pointer.touch ? 4 : 2)) { pointer.moved = true; ring.classList.remove('is-pressed') }
      if (pointer.moved) {
        const evs = e.getCoalescedEvents?.() || [e]
        for (const ev of evs) {
          const w = lake.worldAt(ev.clientX, ev.clientY)
          if (!w) continue
          const t = ev.timeStamp, dt = Math.max(4, t - pointer.lastT) / 1000
          lake.drag(pointer.last[0], pointer.last[1], w[0], w[1], dt)
          const speed = Math.hypot(w[0] - pointer.last[0], w[1] - pointer.last[1]) / dt
          pointer.path = (pointer.path || 0) + Math.hypot(ev.clientX - (pointer.px ?? pointer.x), ev.clientY - (pointer.py ?? pointer.y))
          const pxSpeed = Math.hypot(ev.clientX - (pointer.px ?? pointer.x), ev.clientY - (pointer.py ?? pointer.y)) / Math.max(4, t - pointer.lastT)
          pointer.px = ev.clientX; pointer.py = ev.clientY
          if (pointer.path >= 32) swishSound(pxSpeed, clamp(ev.clientY / innerHeight, 0, 1), clamp((ev.clientX / innerWidth) * 2 - 1, -1, 1) * 0.4)
          pointer.last = w
          pointer.lastT = t
        }
      }
    } else if (pointer?.kind === 'dial-touch') {
      const dy = e.clientY - pointer.y
      if (pointer.moved || Math.abs(dy) > 4) { pointer.moved = true; scrubbing = true; setCustom(pointer.min - (dy / (dialH / 2)) * 360) }
    }
    updateCursorThrottled()
  })

  const end = (e) => {
    unlockAudio()
    if (!pointer) return
    if (pointer.kind === 'water') {
      if (!pointer.moved) {
        const hold = performance.now() - pointer.t
        lake.tap(pointer.w[0], pointer.w[1], hold)
        maybeShowIntro()
        splashSound(clamp(e.clientY / innerHeight, 0, 1), 0.8 + Math.min(hold, 260) / 260 * 0.35)
        ring.classList.remove('is-tap-pulsing')
        void ring.offsetWidth
        ring.classList.add('is-tap-pulsing')
        setTimeout(() => ring.classList.remove('is-pressed'), Math.max(0, 180 - hold))
      } else {
        suppressUntil = performance.now() + 500
      }
    }
    if (pointer.kind === 'dial-touch' && !pointer.moved) setView('resting')
    scrubbing = false
    pointer = null
  }
  lakeEl.addEventListener('pointerup', end)
  lakeEl.addEventListener('pointercancel', end)
  lakeEl.addEventListener('pointerleave', () => ring.classList.remove('is-visible'))
  // swallow the synthetic click after a drag
  addEventListener('click', (e) => { if (performance.now() < suppressUntil && e.target.closest('.control')) { e.stopPropagation(); e.preventDefault() } }, true)

  // 不再有右键菜单：右键就是浏览器自带的菜单
  document.addEventListener('gesturestart', (e) => e.preventDefault())
}

// While a finger rests on the water, press a gentle dimple into it.
function holdTick() {
  if (pointer?.kind === 'water' && !pointer.moved) {
    const held = (performance.now() - pointer.t) / 1000
    lake.press(pointer.w[0], pointer.w[1], Math.min(1, held * 4))
  }
}

// ---------------------------------------------------------------- keyboard

function bindKeys() {
  let repeat = null
  addEventListener('keydown', (e) => {
    if (!['Escape', 'Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) unlockAudio()
    if (e.key === 'Escape') {
      if (closeMenu()) return
      if (view !== 'resting') setView('resting')
      return
    }
    if (e.key === ' ' && !e.target.closest?.('button, a, input')) { e.preventDefault(); if (!e.repeat) togglePlay(); return }
    const dir = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }[e.key] // 往后的时节排在下面，↓ 就是下一个
    if (dir && !e.target.closest?.('input')) {
      e.preventDefault()
      if (e.repeat) return
      const stepMin = e.shiftKey ? 1 : 3
      const go = () => { scrubbing = true; setCustom(minutesNow() + dir * stepMin) }
      go()
      clearTimeout(repeat?.t); clearInterval(repeat?.i)
      repeat = { t: setTimeout(() => (repeat.i = setInterval(go, e.shiftKey ? 160 : 8)), 320) }
    }
  })
  addEventListener('blur', () => { clearTimeout(repeat?.t); clearInterval(repeat?.i); repeat = null; scrubbing = false })
  addEventListener('keyup', (e) => {
    if (e.key.startsWith('Arrow')) { clearTimeout(repeat?.t); clearInterval(repeat?.i); repeat = null; scrubbing = false }
  })
}

// ---------------------------------------------------------------- fallback: TV static

function staticFallback() {
  html.classList.add('webgl-unavailable')
  const c = $('#fallback-water'), x = c.getContext('2d')
  const H = 432
  const draw = () => {
    const W = Math.max(1, Math.round((H * innerWidth) / Math.max(1, innerHeight)))
    if (c.width !== W) { c.width = W; c.height = H }
    const img = x.createImageData(W, H)
    for (let yy = 0; yy < H; yy++) {
      const row = 0.8 + Math.random() * 0.2
      for (let xx = 0; xx < W; xx++) { const v = Math.random() * 150 * row + 40, i = (yy * W + xx) * 4; img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255 }
    }
    x.putImageData(img, 0, 0)
  }
  setInterval(draw, 1000 / 24)
  draw()
}

// ---------------------------------------------------------------- boot

function arrive() {
  html.classList.add('water-ready', 'arrival-revealing')
  html.classList.remove('is-arriving')
  lakeEl.inert = false
  $('#traveling')?.remove()
  setTimeout(() => html.classList.remove('arrival-revealing'), 1200)
}

function loop() {
  requestAnimationFrame(loop)
  if (timeAnim) {
    const p = Math.min(1, (performance.now() - timeAnim.t0) / timeAnim.dur)
    const e = 1 - Math.pow(1 - p, 4)
    offset = shortest(timeAnim.from + timeAnim.delta * e - realMinutes())
    if (p >= 1) { if (timeAnim.clearAfter) offset = null; timeAnim = null }
  }
  const min = minutesNow()
  lake?.setYear(seasonAt(min / 1440))
  renderTime(min)
  seasonEvents(min)
  if (view === 'time') layoutTicks(min)
  if (view === 'waveform' && playing) drawWaveform()
  if (lake) holdTick()
  if (hover.x >= 0 && lake && !pointer) updateCursorThrottled()
}

// While the year flows on its own: a bowl at each turn of the season, and a line of verse now and then.
let lastPhase = null, lastAmb = 0
function seasonEvents(min) {
  const p = wrap(min) / 1440
  const now = performance.now()
  if (now - lastAmb > 500) { lastAmb = now; updateAmbience(min); updateFavicon(seasonAt(p).hours * 60) }
  if (lastPhase !== null && !scrubbing && !timeAnim) {
    let d = p - lastPhase
    if (d < -0.5) d += 1
    if (d > 0 && d < 0.01) {
      const crossed = (x) => (lastPhase < x && lastPhase + d >= x) || (lastPhase < x + 1 && lastPhase + d >= x + 1)
      if ([0, 0.25, 0.5, 0.75].some(crossed)) bowl()
      if (crossed(0)) showLine(RETURN_LINE)
      else for (const [at, text] of LINES) if (crossed(at)) showLine(text)
    }
  }
  lastPhase = p
}

let verseTimer = 0
function showLine(text) {
  const el = $('#verse')
  el.classList.remove('is-visible')
  clearTimeout(verseTimer)
  verseTimer = setTimeout(() => {
    el.textContent = text
    el.classList.add('is-visible')
    verseTimer = setTimeout(() => el.classList.remove('is-visible'), 11000)
  }, el.textContent ? 1600 : 0)
}

let lastCursor = 0
function updateCursorThrottled() {
  const t = performance.now()
  if (t - lastCursor < 16) return
  lastCursor = t
  updateCursor(hover.x, hover.y)
}

async function boot() {
  const forced = new URLSearchParams(location.search).get('view') // ?view=vast previews the horizon camera
  const scene = forced ? { view: forced, seed: 0 } : nextScene()
  document.body.dataset.view = scene.view
  $('#change-scene').addEventListener('click', (e) => { e.preventDefault(); location.reload() })
  menu.addEventListener('click', (e) => { if (e.target.closest('a') && e.target.id !== 'change-scene') closeMenu() })
  $('#time-button').addEventListener('click', () => setView('time'))
  $('#site-title').addEventListener('click', () => setView('about'))
  document.addEventListener('pointerdown', (e) => {
    if (view === 'about' && !introHeld() && !e.target.closest('.about-panel, .site-title')) setView('resting')
    if (view === 'waveform' && !e.target.closest('.track-waveform, .track-title')) setView('resting')
  }, true)
  measureDial()
  addEventListener('resize', measureDial)
  bindDial()
  bindMusic()
  bindPointer()
  bindKeys()
  $('#time-scrubber').inert = true
  $('#track-waveform').inert = true
  loop()
  try {
    lake = await createLake($('#water'), scene)
    lake.setYear(seasonAt(minutesNow() / 1440))
    window.__setTime = setCustom // debug: __setTime(phase * 1440) jumps to a point in the year from the console
    await lake.ready
    arrive()
  } catch (err) {
    console.error(err)
    arrive()
    staticFallback()
  }
}

document.fonts?.ready.then(measureDial)
boot()
