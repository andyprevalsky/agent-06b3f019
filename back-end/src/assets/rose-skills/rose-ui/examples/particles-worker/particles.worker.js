// Particle system that lives entirely in a worker: simulation at a fixed 120 Hz,
// rendering into an OffscreenCanvas at the display rate (60/120 Hz), WebGL2 points
// with additive blending (2D canvas fallback). The main thread only forwards size,
// pointer and pause/resume messages, so page jank cannot stall the animation.
'use strict';

const STEP = 1 / 120;
const MAX_STEPS_PER_FRAME = 4;
let canvas = null;
let gl = null;
let ctx2d = null;
let program = null;
let buffer = null;
let uniforms = {};
let count = 0;
let pos = null; // x, y in [0, 1)
let vel = null;
let gpuData = null; // x, y, speed per particle
let pointer = { x: 0.5, y: 0.5, active: false };
let running = false;
let raf = 0;
let last = 0;
let acc = 0;
let time = 0;
let dpr = 1;

const nextFrame = self.requestAnimationFrame
  ? (cb) => self.requestAnimationFrame(cb)
  : (cb) => self.setTimeout(() => cb(performance.now()), 1000 / 120);
const cancelFrame = self.cancelAnimationFrame
  ? (id) => self.cancelAnimationFrame(id)
  : (id) => self.clearTimeout(id);

function seed(n) {
  count = n;
  pos = new Float32Array(n * 2);
  vel = new Float32Array(n * 2);
  gpuData = new Float32Array(n * 3);
  let s = 0x9e3779b9;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < n; i++) {
    pos[i * 2] = rand();
    pos[i * 2 + 1] = rand();
  }
}

// The flow field is evaluated on a coarse grid once per step (FW x FH trig calls)
// and sampled by every particle, instead of trig per particle: ~6x cheaper.
const FW = 64;
const FH = 40;
const fieldX = new Float32Array(FW * FH);
const fieldY = new Float32Array(FW * FH);

function updateField() {
  for (let gy = 0; gy < FH; gy++) {
    for (let gx = 0; gx < FW; gx++) {
      const x = gx / FW;
      const y = gy / FH;
      const a = Math.sin(x * 6.0 + time * 0.35) * Math.cos(y * 5.0 - time * 0.27) * Math.PI * 2;
      fieldX[gy * FW + gx] = Math.cos(a) * 0.12;
      fieldY[gy * FW + gx] = Math.sin(a) * 0.12;
    }
  }
}

/** Flow field plus a soft pull toward the pointer. */
function step(dt) {
  time += dt;
  updateField();
  const aspect = canvas.width / Math.max(1, canvas.height);
  for (let i = 0; i < count; i++) {
    const ix = i * 2;
    const x = pos[ix];
    const y = pos[ix + 1];
    const cell = ((y * FH) | 0) * FW + ((x * FW) | 0);
    let ax = fieldX[cell];
    let ay = fieldY[cell];
    if (pointer.active) {
      const dx = (pointer.x - x) * aspect;
      const dy = pointer.y - y;
      const d2 = dx * dx + dy * dy + 0.002;
      const f = 0.004 / d2;
      ax += dx * f;
      ay += dy * f;
    }
    let vx = (vel[ix] + ax * dt) * 0.985;
    let vy = (vel[ix + 1] + ay * dt) * 0.985;
    vel[ix] = vx;
    vel[ix + 1] = vy;
    let nx = x + (vx / aspect) * dt;
    let ny = y + vy * dt;
    // Wrap to [0, 1); guard the float32 round-up to exactly 1.0.
    const wx = nx - Math.floor(nx);
    const wy = ny - Math.floor(ny);
    pos[ix] = wx < 0.9999 ? wx : 0;
    pos[ix + 1] = wy < 0.9999 ? wy : 0;
  }
}

const VS = `#version 300 es
in vec3 a; uniform float uSize; out float vSpeed;
void main() {
  vSpeed = a.z;
  gl_Position = vec4(a.x * 2.0 - 1.0, 1.0 - a.y * 2.0, 0.0, 1.0);
  gl_PointSize = uSize;
}`;
const FS = `#version 300 es
precision mediump float; in float vSpeed; out vec4 o;
void main() {
  float d = length(gl_PointCoord - 0.5);
  float alpha = smoothstep(0.5, 0.0, d) * 0.55;
  vec3 slow = vec3(0.35, 0.45, 1.0), fast = vec3(1.0, 0.45, 0.7);
  o = vec4(mix(slow, fast, clamp(vSpeed * 6.0, 0.0, 1.0)) * alpha, alpha);
}`;

function setupGl() {
  gl = canvas.getContext('webgl2', { alpha: false, antialias: false, powerPreference: 'low-power' });
  if (!gl) return false;
  const compile = (type, src) => {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    return sh;
  };
  program = gl.createProgram();
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VS));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FS));
  gl.linkProgram(program);
  gl.useProgram(program);
  buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, gpuData.byteLength, gl.DYNAMIC_DRAW);
  const loc = gl.getAttribLocation(program, 'a');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
  uniforms.size = gl.getUniformLocation(program, 'uSize');
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE); // additive glow, premultiplied in the shader
  return true;
}

function draw() {
  for (let i = 0; i < count; i++) {
    gpuData[i * 3] = pos[i * 2];
    gpuData[i * 3 + 1] = pos[i * 2 + 1];
    gpuData[i * 3 + 2] = Math.hypot(vel[i * 2], vel[i * 2 + 1]);
  }
  if (gl) {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0.03, 0.03, 0.07, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, gpuData);
    gl.uniform1f(uniforms.size, 3.0 * dpr);
    gl.drawArrays(gl.POINTS, 0, count);
    return;
  }
  ctx2d.globalCompositeOperation = 'source-over';
  ctx2d.fillStyle = '#08080f';
  ctx2d.fillRect(0, 0, canvas.width, canvas.height);
  ctx2d.globalCompositeOperation = 'lighter';
  ctx2d.fillStyle = 'rgba(140, 150, 255, 0.5)';
  const size = 2 * dpr;
  for (let i = 0; i < count; i++) ctx2d.fillRect(gpuData[i * 3] * canvas.width, gpuData[i * 3 + 1] * canvas.height, size, size);
}

function frame(now) {
  raf = 0;
  const dt = last ? Math.min(0.1, (now - last) / 1000) : STEP;
  last = now;
  acc += dt;
  let steps = 0;
  while (acc >= STEP && steps < MAX_STEPS_PER_FRAME) {
    step(STEP);
    acc -= STEP;
    steps++;
  }
  if (steps === MAX_STEPS_PER_FRAME) acc = 0; // never spiral after a stall
  draw();
  if (running) raf = nextFrame(frame);
}

function setRunning(next) {
  running = next;
  if (running && !raf) {
    last = 0;
    raf = nextFrame(frame);
  } else if (!running && raf) {
    cancelFrame(raf);
    raf = 0;
  }
}

self.onmessage = (event) => {
  const msg = event.data;
  if (msg.type === 'init') {
    canvas = msg.canvas;
    dpr = msg.dpr;
    canvas.width = msg.width;
    canvas.height = msg.height;
    seed(msg.count);
    const mode = setupGl() ? 'offscreen-webgl2' : ((ctx2d = canvas.getContext('2d')), 'offscreen-2d');
    for (let i = 0; i < 90; i++) step(STEP); // settle into the flow before the first paint
    draw();
    self.postMessage({ type: 'ready', mode });
  } else if (msg.type === 'resize') {
    canvas.width = msg.width;
    canvas.height = msg.height;
    dpr = msg.dpr;
    if (!running) draw();
  } else if (msg.type === 'pointer') {
    pointer = msg.pointer;
  } else if (msg.type === 'run') {
    setRunning(msg.running);
  }
};
