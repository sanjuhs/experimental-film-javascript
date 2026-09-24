/* Maison Lumière — an experimental home-tour film written entirely in JavaScript.
   A tiny perspective 3D engine on Canvas 2D: convex objects, per-face lighting,
   ACES tone mapping, sun beams, bloom, grain, and a generative Web Audio score. */
(() => {
'use strict';

const W = 1920, H = 1080, DUR = 36.5;

// ---------------------------------------------------------------- math
const clamp = (v, a = 0, b = 1) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const easeSine = t => -(Math.cos(Math.PI * t) - 1) / 2;
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = a => Math.hypot(a[0], a[1], a[2]);
const norm = a => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
function rng(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- color
const toLin = c => Math.pow(c / 255, 2.2);
const aces = x => clamp((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14));
const outC = (x, e) => Math.round(Math.pow(aces(x * e), 1 / 2.2) * 255);
const rgb = (r, g, b) => `rgb(${r},${g},${b})`;

// ---------------------------------------------------------------- camera
function makeCam(c) {
  const cy = Math.cos(c.yaw), sy = Math.sin(c.yaw), cp = Math.cos(c.pitch), sp = Math.sin(c.pitch);
  const F = (W / 2) / Math.tan((c.fov || 1.22) / 2);
  const pos = [c.x, c.y, c.z];
  const toCam = p => {
    const dx = p[0] - c.x, dy = p[1] - c.y, dz = p[2] - c.z;
    const xc = dx * cy - dz * sy; let zc = dx * sy + dz * cy;
    const yc = dy * cp - zc * sp; zc = dy * sp + zc * cp;
    return [xc, yc, zc];
  };
  const proj = q => [W / 2 + F * q[0] / q[2], H / 2 - F * q[1] / q[2]];
  const pw = p => { const q = toCam(p); return q[2] > 0.02 ? proj(q) : null; };
  return { pos, F, yaw: c.yaw, pitch: c.pitch, toCam, proj, pw, fwd: [sy, 0, cy] };
}

function clipNear(qs, near = 0.05) {
  const out = [];
  for (let i = 0; i < qs.length; i++) {
    const a = qs[i], b = qs[(i + 1) % qs.length];
    const ain = a[2] > near, bin = b[2] > near;
    if (ain) out.push(a);
    if (ain !== bin) {
      const t = (near - a[2]) / (b[2] - a[2]);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), near]);
    }
  }
  return out;
}

function pathWorld(ctx, cam, pts) {
  const cl = clipNear(pts.map(cam.toCam));
  if (cl.length < 3) return false;
  ctx.beginPath();
  cl.forEach((q, i) => { const s = cam.proj(q); i ? ctx.lineTo(s[0], s[1]) : ctx.moveTo(s[0], s[1]); });
  ctx.closePath();
  return true;
}

function drawFace(ctx, cam, f, t) {
  if (dot(f.n, sub(cam.pos, f.p[0])) <= 0) return;
  if (!pathWorld(ctx, cam, f.p)) return;
  if (f.paint) {
    ctx.save(); ctx.clip(); f.paint(ctx, cam, t, f); ctx.restore();
  } else {
    ctx.fillStyle = f.col; ctx.fill();
    ctx.strokeStyle = f.col; ctx.lineWidth = 1; ctx.stroke();
  }
  if (f.grout) { ctx.strokeStyle = f.grout; ctx.lineWidth = f.gw || 1.2; ctx.stroke(); }
}

// ---------------------------------------------------------------- world builder
class World {
  constructor(o = {}) {
    Object.assign(this, { amb: [.25, .24, .26], lights: [], exposure: 1.15, shell: [], objs: [] }, o);
    this.r = rng(o.seed || 7);
  }
  shade(mat, c, n, ao = 1) {
    if (!mat.c) return "#000";
    if (mat.emit) return rgb(...mat.c);
    const v = mat.vary ? 1 + (this.r() - .5) * 2 * mat.vary : 1;
    const hemi = .72 + .28 * n[1];
    let r = this.amb[0] * hemi, g = this.amb[1] * hemi, b = this.amb[2] * hemi;
    for (const L of this.lights) {
      const d = sub(L.p, c), dist = len(d) || 1e-3;
      let ndl = dot(n, mul(d, 1 / dist)); ndl = Math.max(0, (ndl + .2) / 1.2);
      const att = L.i / (1 + dist * dist / (L.r * L.r));
      r += L.c[0] * att * ndl; g += L.c[1] * att * ndl; b += L.c[2] * att * ndl;
    }
    const e = this.exposure * (mat.gain || 1) * ao * v;
    return rgb(outC(toLin(mat.c[0]) * r, e), outC(toLin(mat.c[1]) * g, e), outC(toLin(mat.c[2]) * b, e));
  }
  plane(o, u, v, nu, nv, mat, opt = {}) {
    let n = norm(cross(u, v));
    const c0 = add(add(o, mul(u, .5)), mul(v, .5));
    if (opt.toward && dot(n, sub(opt.toward, c0)) < 0) n = mul(n, -1);
    if (opt.away && dot(n, sub(opt.away, c0)) > 0) n = mul(n, -1);
    const faces = [];
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const a = add(add(o, mul(u, i / nu)), mul(v, j / nv));
      const b = add(a, mul(u, 1 / nu)), c = add(b, mul(v, 1 / nv)), d = add(a, mul(v, 1 / nv));
      const cen = mul(add(a, c), .5);
      faces.push({ p: [a, b, c, d], n, col: this.shade(mat, cen, n, opt.ao ? opt.ao(cen) : 1),
        grout: mat.grout, gw: mat.gw, paint: mat.paint });
    }
    if (opt.shell) this.shell.push(...faces);
    return faces;
  }
  // room shell: x in [-w/2,w/2], y in [0,h], z in [0,d]
  room(w, h, d, m) {
    const cen = [0, h / 2, d / 2], x0 = -w / 2;
    const ao = p => {
      const ds = [p[0] - x0, -x0 - p[0], p[1], h - p[1], p[2], d - p[2]].filter(v => v > 1e-3);
      return .6 + .4 * sstep(0, 1.1, Math.min(...ds));
    };
    const N = (L, cell) => Math.max(1, Math.round(L / cell));
    const S = (o, u, v, mat, cell) =>
      this.plane(o, u, v, N(len(u), cell), N(len(v), cell), mat, { toward: cen, ao, shell: true });
    S([x0, 0, 0], [w, 0, 0], [0, 0, d], m.floor, m.floorCell || .5);
    S([x0, h, 0], [w, 0, 0], [0, 0, d], m.ceil || m.wall, .9);
    const walls = [
      [[x0, 0, d], [w, 0, 0], m.back],
      [[x0, 0, 0], [0, 0, d], m.left],
      [[-x0, 0, 0], [0, 0, d], m.right],
      [[x0, 0, 0], [w, 0, 0], m.front],
    ];
    for (const [o, u, over] of walls) {
      const mat = over || m.wall;
      if (m.wain) {
        const wh = m.wain.h;
        S(o, u, [0, wh, 0], m.wain.mat, m.wain.cell || .25);
        S(add(o, [0, wh, 0]), u, [0, h - wh, 0], mat, .45);
      } else S(o, u, [0, h, 0], mat, .45);
    }
  }
  decal(o, u, v, nu, nv, mat, toward) { return this.plane(o, u, v, nu, nv, mat, { toward, shell: true }); }
  obj(faces, c, bias = 0) { const o = { faces, c, bias }; this.objs.push(o); return o; }
  obox(o, U, V, Wv, mat, opt = {}) {
    const c = add(o, mul(add(add(U, V), Wv), .5)), s = opt.sub || [1, 1, 1];
    const P = (oo, u, v, nu, nv, m) => this.plane(oo, u, v, nu, nv, m, { away: c });
    const f = [
      ...P(add(o, V), U, Wv, s[0], s[2], opt.top || mat),
      ...P(o, U, V, s[0], s[1], opt.front || mat),
      ...P(add(o, Wv), U, V, s[0], s[1], opt.back || mat),
      ...P(o, Wv, V, s[2], s[1], opt.side || mat),
      ...P(add(o, U), Wv, V, s[2], s[1], opt.side || mat),
    ];
    if (opt.bottom) f.push(...P(o, U, Wv, 1, 1, mat));
    return this.obj(f, c, opt.bias);
  }
  box(x0, y0, z0, x1, y1, z1, mat, opt) {
    return this.obox([x0, y0, z0], [x1 - x0, 0, 0], [0, y1 - y0, 0], [0, 0, z1 - z0], mat, opt);
  }
  prism(poly, y0, y1, mat, opt = {}) {
    const cx = poly.reduce((s, p) => s + p[0], 0) / poly.length, cz = poly.reduce((s, p) => s + p[1], 0) / poly.length;
    const c = [cx, (y0 + y1) / 2, cz], f = [];
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length];
      f.push(...this.plane([a[0], y0, a[1]], [b[0] - a[0], 0, b[1] - a[1]], [0, y1 - y0, 0], 1, 1, opt.side || mat, { away: c }));
    }
    const top = poly.map(p => [p[0], y1, p[1]]);
    const tm = opt.top || mat;
    f.push({ p: top, n: [0, 1, 0], col: this.shade(tm, [cx, y1, cz], [0, 1, 0]), paint: tm.paint });
    return this.obj(f, c, opt.bias);
  }
  cyl(cx, cz, r, y0, y1, mat, opt = {}) { return this.prism(ellipse(cx, cz, r, r, opt.seg || 22), y0, y1, mat, opt); }
  disc(center, axis, r, mat, sign, bias = 0, seg = 36) {
    const pts = [];
    for (let i = 0; i < seg; i++) {
      const a = i / seg * Math.PI * 2, u = Math.cos(a) * r, v = Math.sin(a) * r;
      pts.push(axis === 'x' ? [center[0], center[1] + v, center[2] + u] : [center[0] + u, center[1] + v, center[2]]);
    }
    const n = axis === 'x' ? [sign, 0, 0] : [0, 0, sign];
    return this.obj([{ p: pts, n, col: this.shade(mat, center, n), paint: mat.paint }], center, bias);
  }
  sprite(p, draw, bias = 0) { const o = { sprite: true, c: p, draw, bias }; this.objs.push(o); return o; }
  capture(fn) { const prev = this.objs; this.objs = []; fn(); const r = this.objs; this.objs = prev; return r; }
}
const ellipse = (cx, cz, rx, rz, n = 28) =>
  Array.from({ length: n }, (_, i) => { const a = i / n * Math.PI * 2; return [cx + Math.cos(a) * rx, cz + Math.sin(a) * rz]; });

function renderWorld(ctx, world, camS, t) {
  const cam = makeCam(camS);
  ctx.save();
  if (world.bg) world.bg(ctx, cam, t); else { ctx.fillStyle = '#0c0a09'; ctx.fillRect(0, 0, W, H); }
  for (const f of world.shell) drawFace(ctx, cam, f, t);
  if (world.pre) world.pre(ctx, cam, t);
  const objs = world.dyn ? world.objs.concat(world.dyn(t)) : world.objs;
  const list = objs.map(o => ({ o, d: len(sub(o.c, cam.pos)) - o.bias })).sort((a, b) => b.d - a.d);
  for (const { o } of list) {
    if (o.sprite) {
      const q = cam.toCam(o.c);
      if (q[2] > .15) { const s = cam.proj(q); o.draw(ctx, s[0], s[1], cam.F / q[2], t, cam); }
    } else for (const f of o.faces) drawFace(ctx, cam, f, t);
  }
  if (world.post) world.post(ctx, cam, t);
  ctx.restore();
}

// ---------------------------------------------------------------- camera paths
function camPath(keys, u, fov = 1.22) {
  const n = keys.length - 1, f = clamp(u) * n, i = Math.min(n - 1, Math.floor(f)), t = f - i;
  const p0 = keys[Math.max(0, i - 1)], p1 = keys[i], p2 = keys[i + 1], p3 = keys[Math.min(n, i + 2)];
  const v = p1.map((_, k) => {
    const a = p0[k], b = p1[k], c = p2[k], d = p3[k];
    return .5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
  });
  return { x: v[0], y: v[1], z: v[2], yaw: v[3], pitch: v[4], fov };
}

// ---------------------------------------------------------------- painters & sprites
function skyPainter(o) {
  const r = rng(o.seed || 3);
  const stars = o.stars ? Array.from({ length: 220 }, () => {
    const a = (r() - .5) * 3.4, e = .05 + Math.pow(r(), .7) * .9;
    return [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e), r()];
  }) : [];
  return (ctx, cam, t) => {
    const hz = cam.pw(add(cam.pos, mul(cam.fwd, 1000)));
    const hy = hz ? hz[1] : H / 2;
    const g = ctx.createLinearGradient(0, hy - 1300, 0, hy + 40);
    o.stops.forEach(([s, c]) => g.addColorStop(s, c));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    for (const s of stars) {
      const p = cam.pw(add(cam.pos, mul(s, 1000)));
      if (!p) continue;
      ctx.fillStyle = `rgba(255,248,230,${(.35 + .5 * s[3]) * (.7 + .3 * Math.sin(t * 2 + s[3] * 20)) * clamp((hy - p[1]) / 300)})`;
      ctx.fillRect(p[0], p[1], 2 + s[3] * 1.5, 2 + s[3] * 1.5);
    }
    if (o.sun) {
      const p = cam.pw(add(cam.pos, mul(norm(o.sun), 1000)));
      if (p) {
        const R = o.sunR || 420, gg = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], R);
        gg.addColorStop(0, o.sunCore || 'rgba(255,246,220,1)');
        gg.addColorStop(.08, o.sunMid || 'rgba(255,214,150,.85)');
        gg.addColorStop(.35, o.sunHalo || 'rgba(255,170,100,.25)');
        gg.addColorStop(1, 'rgba(255,150,90,0)');
        ctx.fillStyle = gg; ctx.fillRect(p[0] - R, p[1] - R, R * 2, R * 2);
      }
    }
    (o.hills || []).forEach(([col, amp, seed]) => {
      ctx.beginPath(); let started = false;
      for (let a = -2.6; a <= 2.6; a += .04) {
        const h = amp * (.55 + .45 * Math.sin(a * 2.3 + seed) + .25 * Math.sin(a * 6.1 + seed * 2));
        const p = cam.toCam(add(cam.pos, [Math.sin(a) * 1000, (h - .005) * 1000, Math.cos(a) * 1000]));
        if (p[2] < 10) continue;
        const s = cam.proj(p);
        started ? ctx.lineTo(s[0], s[1]) : (ctx.moveTo(s[0], H + 400), ctx.lineTo(s[0], s[1]), started = true);
        ctx._lx = s[0];
      }
      if (started) { ctx.lineTo(ctx._lx, H + 400); ctx.closePath(); ctx.fillStyle = col; ctx.fill(); }
    });
  };
}

function glow(size, col, alpha = 1, flick = 0) {
  return (ctx, x, y, s, t) => {
    const a = alpha * (1 - flick * (.5 + .5 * Math.sin(t * 13 + Math.sin(t * 7) * 2)));
    const r = size * s; if (r < 1) return;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${col},${a})`); g.addColorStop(.18, `rgba(${col},${a * .45})`);
    g.addColorStop(.5, `rgba(${col},${a * .1})`); g.addColorStop(1, `rgba(${col},0)`);
    ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = g; ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
    ctx.globalCompositeOperation = 'source-over';
  };
}

function plant(seed, o = {}) {
  const r = rng(seed), h = o.h || 1.2, ph = o.potH || .34, pwid = o.potW || .36, n = o.n || 22;
  const leaves = Array.from({ length: n }, (_, i) => {
    const k = i / n;
    return { y: -ph - .05 - k * h * .85, a: (r() - .5) * 2.4 * (1 - k * .45), L: (.16 + r() * .14) * (o.leaf || 1) * (1 - k * .25),
      w: .45 + r() * .3, c: o.cols[Math.floor(r() * o.cols.length)], ph: r() * 6 };
  });
  return (ctx, x, y, s, t) => {
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
    ctx.strokeStyle = o.stem || '#3f3122'; ctx.lineWidth = .018;
    ctx.beginPath(); ctx.moveTo(0, -ph); ctx.quadraticCurveTo(.04, -ph - h * .5, 0, -ph - h * .86); ctx.stroke();
    for (const L of leaves) {
      const sw = Math.sin(t * .9 + L.ph) * .04;
      ctx.save(); ctx.translate(Math.sin(L.y * 4) * .02, L.y); ctx.rotate(L.a + sw);
      ctx.fillStyle = L.c; ctx.beginPath(); ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(L.L * L.w, -L.L * .45, 0, -L.L); ctx.quadraticCurveTo(-L.L * L.w, -L.L * .55, 0, 0); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,230,.14)'; ctx.lineWidth = .006;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -L.L * .9); ctx.stroke();
      ctx.restore();
    }
    const g = ctx.createLinearGradient(-pwid / 2, 0, pwid / 2, 0);
    g.addColorStop(0, o.potDark || '#5e3a26'); g.addColorStop(.55, o.pot || '#b77a52'); g.addColorStop(1, o.potDark || '#5e3a26');
    ctx.fillStyle = g; ctx.beginPath();
    ctx.moveTo(-pwid / 2, -ph); ctx.lineTo(pwid / 2, -ph); ctx.lineTo(pwid * .38, 0); ctx.lineTo(-pwid * .38, 0); ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(0,0,0,.25)'; ctx.fillRect(-pwid / 2, -ph, pwid, .03);
    ctx.restore();
  };
}

function bush(seed, rad, cols) {
  const r = rng(seed);
  const blobs = Array.from({ length: 16 }, () => [(r() - .5) * rad * 1.6, -r() * rad * 1.1, rad * (.35 + r() * .35), cols[Math.floor(r() * cols.length)]]);
  return (ctx, x, y, s) => {
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
    for (const [bx, by, br, c] of blobs) { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(bx, by, br, 0, 7); ctx.fill(); }
    ctx.restore();
  };
}

function tree(seed, h, col) {
  const r = rng(seed);
  const blobs = Array.from({ length: 26 }, () => [(r() - .5) * h * .55, -h * (.45 + r() * .5), h * (.1 + r() * .12)]);
  return (ctx, x, y, s, t) => {
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
    ctx.fillStyle = col; ctx.fillRect(-h * .02, -h * .5, h * .04, h * .5);
    const sw = Math.sin(t * .6 + seed) * h * .01;
    for (const [bx, by, br] of blobs) { ctx.beginPath(); ctx.arc(bx + sw, by, br, 0, 7); ctx.fill(); }
    ctx.restore();
  };
}

function fruitBowl() {
  const fruits = [[-.09, -.085, '#f0a23a', '#9a4a12'], [.07, -.09, '#f3cf4a', '#9a7414'], [-.01, -.13, '#ee8a2a', '#8a3a0e'],
    [.13, -.07, '#a7c254', '#4d6a1c'], [-.14, -.065, '#f3cf4a', '#9a7414']];
  return (ctx, x, y, s) => {
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
    for (const [fx, fy, c, d] of fruits) {
      const g = ctx.createRadialGradient(fx - .02, fy - .025, .004, fx, fy, .06);
      g.addColorStop(0, '#fff3cf'); g.addColorStop(.2, c); g.addColorStop(1, d);
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(fx, fy, .052, 0, 7); ctx.fill();
    }
    const g = ctx.createLinearGradient(-.2, 0, .2, 0);
    g.addColorStop(0, '#bdb3a4'); g.addColorStop(.4, '#f5efe4'); g.addColorStop(1, '#a89e90');
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(-.22, -.075); ctx.bezierCurveTo(-.2, .005, .2, .005, .22, -.075);
    ctx.ellipse(0, -.075, .22, .025, 0, 0, Math.PI, true); ctx.fill();
    ctx.restore();
  };
}

function vase(o) {
  const r = rng(o.seed || 9);
  const stems = Array.from({ length: o.n || 7 }, () => ({ a: (r() - .5) * .9, L: o.h * (.6 + r() * .4), c: o.flower[Math.floor(r() * o.flower.length)] }));
  return (ctx, x, y, s, t) => {
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
    const vh = o.vh || .3, vw = o.vw || .16;
    for (const st of stems) {
      const sw = Math.sin(t * .8 + st.a * 9) * .015;
      const ex = Math.sin(st.a) * st.L + sw, ey = -vh - Math.cos(st.a) * st.L;
      ctx.strokeStyle = o.stem || '#6b5a3a'; ctx.lineWidth = .006;
      ctx.beginPath(); ctx.moveTo(0, -vh + .02); ctx.quadraticCurveTo(ex * .3, (ey - vh) / 2, ex, ey); ctx.stroke();
      ctx.fillStyle = st.c;
      for (let k = 0; k < 7; k++) {
        const kk = .55 + k * .07;
        ctx.beginPath(); ctx.ellipse(ex * kk + (k % 2 ? .012 : -.012), -vh + (ey + vh) * kk, .018, .03, st.a + (k % 2 ? .6 : -.6), 0, 7); ctx.fill();
      }
    }
    const g = ctx.createLinearGradient(-vw / 2, 0, vw / 2, 0);
    g.addColorStop(0, o.dark); g.addColorStop(.45, o.col); g.addColorStop(1, o.dark);
    ctx.fillStyle = g; ctx.beginPath(); ctx.moveTo(-vw * .22, -vh);
    ctx.bezierCurveTo(-vw * .2, -vh * .7, -vw * .7, -vh * .55, -vw * .45, 0); ctx.lineTo(vw * .45, 0);
    ctx.bezierCurveTo(vw * .7, -vh * .55, vw * .2, -vh * .7, vw * .22, -vh); ctx.closePath(); ctx.fill();
    ctx.restore();
  };
}

function candle() {
  return (ctx, x, y, s, t) => {
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s);
    ctx.fillStyle = '#f2ead9'; ctx.fillRect(-.025, -.11, .05, .11);
    const fl = 1 + Math.sin(t * 17) * .08 + Math.sin(t * 5.3) * .06;
    ctx.fillStyle = '#ffd98a'; ctx.beginPath(); ctx.ellipse(0, -.13 * fl, .009, .022 * fl, 0, 0, 7); ctx.fill();
    ctx.restore();
    glow(.35, '255,170,80', .6, .15)(ctx, x, y - .13 * s, s, t);
  };
}

function pillow(w, h, col, dark, rot = 0) {
  return (ctx, x, y, s) => {
    ctx.save(); ctx.translate(x, y); ctx.scale(s, s); ctx.rotate(rot);
    const g = ctx.createRadialGradient(-w * .15, -h * .15, 0, 0, 0, w * .7);
    g.addColorStop(0, col); g.addColorStop(1, dark);
    ctx.fillStyle = g; ctx.beginPath();
    ctx.moveTo(-w / 2, -h / 2); ctx.quadraticCurveTo(0, -h * .38, w / 2, -h / 2); ctx.quadraticCurveTo(w * .4, 0, w / 2, h / 2);
    ctx.quadraticCurveTo(0, h * .38, -w / 2, h / 2); ctx.quadraticCurveTo(-w * .4, 0, -w / 2, -h / 2); ctx.fill();
    ctx.restore();
  };
}

function knob(r = .03) {
  return (ctx, x, y, s) => {
    const R = r * s, g = ctx.createRadialGradient(x - R * .3, y - R * .3, 0, x, y, R);
    g.addColorStop(0, '#fff2c4'); g.addColorStop(.4, '#d4a44f'); g.addColorStop(1, '#6d4c1c');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, R, 0, 7); ctx.fill();
  };
}

// light pool on the floor (projected ellipse with radial falloff)
function pool(ctx, cam, c, r, col, a) {
  const pts = ellipse(c[0], c[2], r, r, 24).map(p => [p[0], c[1], p[1]]);
  const p = cam.pw(c); if (!p) return;
  if (!pathWorld(ctx, cam, pts)) return;
  const edge = cam.pw([c[0] + r, c[1], c[2]]), edge2 = cam.pw([c[0], c[1], c[2] + r]);
  const R = Math.max(edge ? Math.hypot(edge[0] - p[0], edge[1] - p[1]) : 50, edge2 ? Math.hypot(edge2[0] - p[0], edge2[1] - p[1]) : 50);
  const g = ctx.createRadialGradient(p[0], p[1], 0, p[0], p[1], R);
  g.addColorStop(0, `rgba(${col},${a})`); g.addColorStop(1, `rgba(${col},0)`);
  ctx.save(); ctx.globalCompositeOperation = 'lighter'; ctx.fillStyle = g; ctx.fill(); ctx.restore();
}

function clip2D(poly, axis, v, keepGreater) {
  const out = [], inside = p => keepGreater ? p[axis] >= v : p[axis] <= v;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    if (inside(a)) out.push(a);
    if (inside(a) !== inside(b)) { const t = (v - a[axis]) / (b[axis] - a[axis]); out.push(a.map((x, k) => x + t * (b[k] - x))); }
  }
  return out;
}

// sunlight through a window pane: floor patch + volumetric beam + dust
function sunlight(o) {
  const r = rng(o.seed || 5), dir = o.dir;
  const dust = Array.from({ length: o.dust || 70 }, () => ({ u: r(), v: r(), k: r() * .9, ph: r() * 6, sz: .5 + r() }));
  return {
    patch(ctx, cam, t, k = 1) {
      for (const pane of o.panes) {
        let poly = pane.map(p => { const tt = -p[1] / dir[1]; return add(p, mul(dir, tt)); });
        for (const [ax, v, g] of o.bounds) poly = clip2D(poly, ax, v, g);
        if (poly.length < 3 || !pathWorld(ctx, cam, poly)) continue;
        ctx.save(); ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = `rgba(${o.col},${o.patchA * k})`; ctx.fill();
        ctx.restore();
      }
    },
    beams(ctx, cam, t, k = 1) {
      ctx.save(); ctx.globalCompositeOperation = 'lighter';
      for (const pane of o.panes) {
        const c = mul(pane.reduce((s, p) => add(s, p), [0, 0, 0]), 1 / 4);
        const a = cam.pw(c), b = cam.pw(add(c, mul(dir, o.L)));
        for (let i = 0; i < 4; i++) {
          const p0 = pane[i], p1 = pane[(i + 1) % 4];
          if (!pathWorld(ctx, cam, [p0, p1, add(p1, mul(dir, o.L)), add(p0, mul(dir, o.L))])) continue;
          if (a && b) {
            const g = ctx.createLinearGradient(a[0], a[1], b[0], b[1]);
            g.addColorStop(0, `rgba(${o.col},${o.beamA * k})`); g.addColorStop(1, `rgba(${o.col},0)`);
            ctx.fillStyle = g;
          } else ctx.fillStyle = `rgba(${o.col},${o.beamA * k * .4})`;
          ctx.fill();
        }
      }
      // dust motes drifting in the light
      const pane = o.panes[0], last = o.panes[o.panes.length - 1];
      for (const d of dust) {
        const base = add(add(pane[0], mul(sub(last[1], pane[0]), d.u)), mul(sub(pane[3], pane[0]), d.v));
        const p = add(add(base, mul(dir, d.k * o.L * .7)), [Math.sin(t * .3 + d.ph) * .08, Math.sin(t * .21 + d.ph * 2) * .06, 0]);
        const s = cam.pw(p); if (!s) continue;
        const q = cam.toCam(p), rr = Math.max(1, d.sz * cam.F / q[2] * .004);
        ctx.fillStyle = `rgba(255,240,210,${(.25 + .25 * Math.sin(t * 1.3 + d.ph)) * k})`;
        ctx.beginPath(); ctx.arc(s[0], s[1], rr, 0, 7); ctx.fill();
      }
      ctx.restore();
    },
  };
}

// affine paint of a unit square onto a face (for artwork and mirrors)
function affinePaint(draw) {
  return (ctx, cam, t, f) => {
    const a = cam.pw(f.p[0]), b = cam.pw(f.p[1]), d = cam.pw(f.p[3]);
    if (!a || !b || !d) { ctx.fillStyle = '#888'; ctx.fillRect(0, 0, W, H); return; }
    ctx.transform(b[0] - a[0], b[1] - a[1], d[0] - a[0], d[1] - a[1], a[0], a[1]);
    draw(ctx, t);
  };
}

// ================================================================= SCENES
const M = c => ({ c });

// ---------- 0. Exterior at dusk
function sceneExterior() {
  const w = new World({ seed: 11, amb: [.07, .085, .15], exposure: 1.0, lights: [
    { p: [0, 2.3, 3.9], c: [1, .7, .4], i: 1.3, r: 1.6 },
    { p: [-2.6, 1.8, 4.2], c: [1, .68, .38], i: .6, r: 1.4 }, { p: [2.6, 1.8, 4.2], c: [1, .68, .38], i: .6, r: 1.4 },
    { p: [-12, 20, -10], c: [.5, .55, .85], i: .45, r: 40 },
  ] });
  w.bg = skyPainter({ stops: [[0, '#0b1430'], [.45, '#27305a'], [.72, '#8a5a6e'], [.88, '#e0906a'], [1, '#f6c486']],
    sun: [-.9, .015, 1], sunR: 360, stars: true, hills: [['#3a3452', .05, 1], ['#1c1d2c', .028, 4]] });
  w.plane([-30, 0, -20], [60, 0, 0], [0, 0, 45], 14, 12, { c: [58, 72, 56] }, { toward: [0, 5, 0], shell: true });
  w.decal([-.7, .005, -14], [1.4, 0, 0], [0, 0, 18.4], 1, 22, { c: [186, 176, 160], vary: .06, grout: 'rgba(20,20,30,.5)', gw: 2 }, [0, 5, 0]);
  const stucco = { c: [226, 214, 194] };
  w.box(-5, 0, 5, 5, 5, 11, stucco, { sub: [12, 6, 1] });
  // roof
  const A = [-5.6, 4.9, 4.6], B = [5.6, 4.9, 4.6], C = [0, 7.7, 4.6], A2 = [-5.6, 4.9, 11.4], B2 = [5.6, 4.9, 11.4], C2 = [0, 7.7, 11.4];
  const slate = { c: [58, 60, 70] };
  const rc = [0, 6, 8];
  const tri = (pts, mat, bias = 0) => { let n = norm(cross(sub(pts[1], pts[0]), sub(pts[2], pts[0])));
    if (dot(n, sub(rc, pts[0])) > 0) n = mul(n, -1); return { p: pts, n, col: w.shade(mat, pts[0], n) }; };
  w.obj([tri([A, B, C], slate), tri([A, C, C2, A2], slate), tri([C, B, B2, C2], slate)], [0, 5.9, 8]);
  const inset = { p: [[-4.9, 5.0, 4.59], [4.9, 5.0, 4.59], [0, 7.3, 4.59]], n: [0, 0, -1], col: w.shade(stucco, [0, 5.8, 4.6], [0, 0, -1]) };
  w.obj([inset], [0, 5.8, 4.5], 1.2);
  w.disc([0, 5.85, 4.57], 'z', .42, { c: [255, 196, 120], emit: true }, -1, 2);
  // windows
  const winMat = { c: [255, 192, 118], emit: true, grout: 'rgba(40,30,24,1)', gw: 7 };
  for (const x of [-3.6, 1.6]) {
    w.box(x - .08, .92, 4.9, x + 2.08, 2.68, 5, { c: [240, 236, 226] }, { bias: .2 });
    w.obj(w.plane([x, 1, 4.89], [2, 0, 0], [0, 1.6, 0], 2, 2, winMat, { toward: [0, 1, 0] }), [x + 1, 1.8, 4.8], .8);
    w.sprite([x + 1, 0, 4.4], bush(x * 7 + 3, .7, ['#1d2a22', '#24362a', '#2c4230', '#1a241d']), .5);
  }
  // doorway: warm interior + frame + steps
  w.obj(w.plane([-.6, 0, 5.08], [1.2, 0, 0], [0, 2.35, 0], 1, 1, { paint: (ctx, cam) => {
    const a = cam.pw([0, 2.35, 5]), b = cam.pw([0, 0, 5]); if (!a || !b) return;
    const g = ctx.createLinearGradient(0, a[1], 0, b[1]);
    g.addColorStop(0, '#ffdca0'); g.addColorStop(.6, '#ffc478'); g.addColorStop(1, '#d88a4a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  } }, { toward: [0, 1, 0] }), [0, 1.2, 5.08], .1);
  const trim = { c: [238, 232, 220] };
  w.box(-.78, 0, 4.88, -.6, 2.5, 5.0, trim, { bias: .3 }); w.box(.6, 0, 4.88, .78, 2.5, 5.0, trim, { bias: .3 });
  w.box(-.78, 2.35, 4.88, .78, 2.55, 5.0, trim, { bias: .3 });
  w.box(-1.2, 0, 4.3, 1.2, .16, 5, { c: [150, 144, 136] }, { bias: .1 });
  for (const x of [-1.05, 1.05]) {
    w.box(x - .07, 1.95, 4.86, x + .07, 2.25, 5, { c: [30, 28, 26] }, { bias: .4 });
    w.sprite([x, 2.1, 4.84], glow(.7, '255,190,110', .8, .06), 60);
  }
  w.sprite([-9, 0, 14], tree(5, 9, '#141824'), -5); w.sprite([10, 0, 16], tree(8, 10, '#12151f'), -5);
  w.sprite([-7.5, 0, 6], tree(13, 6, '#171c26')); w.sprite([7.2, 0, 6.5], tree(21, 6.5, '#161a24'));
  w.sprite([-1.6, 0, 4.2], bush(99, .45, ['#22332a', '#2b3f31', '#1c2821']), .6);
  w.sprite([1.6, 0, 4.2], bush(98, .45, ['#22332a', '#2b3f31', '#1c2821']), .6);
  const openK = t => sstep(.52, .8, t);
  w.dyn = t => w.capture(() => {
    const a = openK(t) * 1.45, U = [Math.cos(a) * 1.2, 0, Math.sin(a) * 1.2], Wv = [-Math.sin(a) * .06, 0, Math.cos(a) * .06];
    w.obox([-.6, 0, 5], U, [0, 2.35, 0], Wv, { c: [34, 74, 82] }, { sub: [2, 3, 1], front: { c: [34, 74, 82], grout: 'rgba(0,0,0,.35)', gw: 3 }, bias: .7 });
    w.sprite(add(add([-.6, 1.05, 4.97], mul(U, .88)), [0, 0, -.02]), knob(.035), 1);
  });
  const r = rng(77), flies = Array.from({ length: 40 }, () => [(r() - .5) * 12, .3 + r() * 2, 1 + r() * 4, r() * 6]);
  w.pre = (ctx, cam) => { pool(ctx, cam, [0, .02, 3.8], 2.4, '255,170,90', .35); pool(ctx, cam, [-2.6, .02, 4.2], 1.6, '255,170,90', .2); pool(ctx, cam, [2.6, .02, 4.2], 1.6, '255,170,90', .2); };
  w.post = (ctx, cam, t) => {
    ctx.save(); ctx.globalCompositeOperation = 'lighter';
    for (const f of flies) {
      const p = cam.pw([f[0] + Math.sin(t * .5 + f[3]) * .4, f[1] + Math.sin(t * .7 + f[3] * 2) * .2, f[2]]); if (!p) continue;
      const a = .5 + .5 * Math.sin(t * 2.2 + f[3] * 3);
      ctx.fillStyle = `rgba(255,220,140,${a * .7})`; ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, 7); ctx.fill();
      ctx.fillStyle = `rgba(255,200,110,${a * .12})`; ctx.beginPath(); ctx.arc(p[0], p[1], 14, 0, 7); ctx.fill();
    }
    ctx.restore();
  };
  w.cam = u => camPath([[.4, 1.7, -11, -.03, .12], [.25, 1.65, -6, -.02, .08], [0, 1.6, -.5, 0, .04], [0, 1.55, 3.4, 0, .01], [0, 1.52, 5.6, 0, 0]], u);
  w.local = u => u;
  return w;
}

// ---------- 1. Bathroom
function sceneBath() {
  const Wd = 4.4, Hh = 2.9, D = 4.8;
  const w = new World({ seed: 21, amb: [.34, .34, .36], exposure: 1.05, lights: [
    { p: [.4, 1.8, 4.3], c: [1, .93, .8], i: 2.2, r: 2.4 },
    { p: [1.9, 1.9, 2.3], c: [1, .72, .45], i: 1.6, r: 1.2 },
    { p: [0, 2.6, 2.2], c: [1, .86, .7], i: 1.1, r: 2.5 },
  ] });
  w.room(Wd, Hh, D, { floor: { c: [214, 206, 194], vary: .03, grout: 'rgba(0,0,0,.08)' }, floorCell: .6,
    wall: { c: [238, 230, 216] }, wain: { h: 1.25, mat: { c: [150, 176, 158], vary: .09, grout: 'rgba(255,255,255,.28)', gw: 1.4 }, cell: .21 } });
  const sun = sunlight({ dir: norm([-.45, -.55, -1]), col: '255,226,170', patchA: .14, beamA: .04, L: 4,
    panes: [[[-.25, 1.05, 4.79], [.35, 1.05, 4.79], [.35, 2.35, 4.79], [-.25, 2.35, 4.79]], [[.45, 1.05, 4.79], [1.05, 1.05, 4.79], [1.05, 2.35, 4.79], [.45, 2.35, 4.79]]],
    bounds: [[0, -2.2, true], [0, 2.2, false], [2, 0, true], [2, 4.8, false]] });
  w.decal([-.3, 1.0, 4.795], [1.4, 0, 0], [0, 1.4, 0], 1, 1, { paint: skyPainter({ stops: [[0, '#8fb3cf'], [.7, '#dbe6e6'], [1, '#fff4dc']],
    sun: [-.45, .55, 1], sunR: 700, hills: [['#a7b9a0', .06, 2], ['#7f9a7c', .03, 5]] }) }, [0, 1, 0]);
  const frame = { c: [245, 242, 236] };
  w.box(-.36, .96, 4.72, 1.16, 1.04, 4.8, frame, { bias: .2 }); w.box(-.36, 2.36, 4.72, 1.16, 2.44, 4.8, frame);
  for (const x of [-.36, .37, 1.08]) w.box(x, 1.04, 4.74, x + .08, 2.36, 4.8, frame, { bias: .1 });
  // tub
  const white = { c: [246, 244, 240] };
  w.prism(ellipse(-.95, 3.7, .88, .42, 32), 0, .6, white);
  w.prism(ellipse(-.95, 3.7, .78, .33, 32), .6, .602, { c: [150, 196, 196], gain: 1.1 }, { bias: .6 });
  w.cyl(-1.95, 3.7, .025, 0, 1.0, { c: [200, 160, 92] }, { seg: 8 });
  w.box(-1.97, .95, 3.67, -1.72, .99, 3.73, { c: [200, 160, 92] }, { bias: .3 });
  w.box(-1.45, 0, 2.5, -.45, .01, 3.05, { c: [232, 222, 206], grout: 'rgba(0,0,0,.08)' }, { sub: [8, 1, 1] });
  w.sprite([-.3, .6, 3.55], candle(), 1); w.sprite([-.42, .6, 3.75], candle(), 1);
  // vanity
  const oak = { c: [168, 118, 76] }, marble = { c: [236, 232, 226] };
  w.box(1.62, .3, 1.55, 2.2, .86, 3.05, oak, { sub: [1, 1, 2], side: { c: [168, 118, 76], grout: 'rgba(0,0,0,.25)', gw: 2 } });
  w.box(1.58, .86, 1.5, 2.2, .9, 3.1, marble, { bias: .3 });
  w.cyl(1.88, 2.3, .23, .9, 1.06, white, { bias: .6, seg: 28 });
  w.prism(ellipse(1.88, 2.3, .19, .19, 24), 1.06, 1.062, { c: [200, 200, 196] }, { bias: .9 });
  w.box(2.1, .9, 2.27, 2.2, 1.3, 2.33, { c: [200, 160, 92] }, { bias: .5 });
  w.box(1.95, 1.24, 2.27, 2.2, 1.28, 2.33, { c: [200, 160, 92] }, { bias: .7 });
  w.disc([2.195, 1.8, 2.3], 'x', .5, { c: [200, 160, 92] }, -1, .2);
  w.disc([2.185, 1.8, 2.3], 'x', .46, { paint: affinePaint((ctx) => {
    const g = ctx.createLinearGradient(0, 0, 1, 1);
    g.addColorStop(0, '#dfe6e6'); g.addColorStop(.45, '#a7b4b6'); g.addColorStop(.5, '#e9efef'); g.addColorStop(.62, '#9aa8aa'); g.addColorStop(1, '#6c7a7c');
    ctx.fillStyle = g; ctx.fillRect(-2, -2, 5, 5);
  }) }, -1, .4);
  for (const z of [1.62, 2.98]) { w.cyl(2.14, z, .05, 1.65, 1.95, { c: [250, 236, 210], gain: 1.3 }, { seg: 10 }); w.sprite([2.1, 1.82, z], glow(.55, '255,190,120', .6), 60); }
  w.sprite([1.75, .9, 1.75], vase({ h: .25, vh: .16, vw: .1, col: '#c9c0b2', dark: '#7e766c', flower: ['#e8dcc4', '#d8c6a4'], n: 5 }), 1);
  // towel + ladder
  w.box(-2.2, .95, 1.3, -2.14, 1.75, 1.85, { c: [214, 150, 118] }, { bias: .2 });
  w.box(-2.2, 1.7, 1.25, -2.12, 1.76, 1.9, { c: [200, 160, 92] }, { bias: .4 });
  w.sprite([1.75, 0, 4.35], plant(4, { h: 1.3, cols: ['#3f6b3a', '#4f7d42', '#2f5a33', '#5d8c4b'], pot: '#d8cdbd', potDark: '#8f8574' }));
  w.cyl(0, 2.2, .14, 2.45, 2.62, { c: [242, 232, 214], gain: 1.4 }); w.box(-.005, 2.62, 2.195, .005, 2.9, 2.205, { c: [30, 30, 30] });
  w.sprite([0, 2.46, 2.2], glow(1.2, '255,210,160', .55), 60);
  w.pre = (ctx, cam, t) => sun.patch(ctx, cam, t);
  w.post = (ctx, cam, t) => sun.beams(ctx, cam, t);
  w.cam = u => camPath([[.5, 1.62, .25, -.42, -.2], [.2, 1.55, .7, -.12, -.16], [-.1, 1.5, 1.05, .3, -.14], [-.25, 1.45, 1.25, .72, -.13]], u);
  return w;
}

// ---------- 2. Kitchen
function sceneKitchen() {
  const Wd = 6.4, Hh = 3.1, D = 6.5;
  const w = new World({ seed: 31, amb: [.34, .33, .33], exposure: 1.15, lights: [
    { p: [0, 2.2, 6.2], c: [1, .95, .85], i: 2.4, r: 3 },
    { p: [-.8, 1.9, 3.5], c: [1, .72, .45], i: .9, r: 1.1 }, { p: [0, 1.9, 3.5], c: [1, .72, .45], i: .9, r: 1.1 }, { p: [.8, 1.9, 3.5], c: [1, .72, .45], i: .9, r: 1.1 },
    { p: [-2.5, 2, 2], c: [.85, .9, 1], i: 1.1, r: 3.5 },
  ] });
  w.room(Wd, Hh, D, { floor: { c: [178, 128, 86], vary: .1, grout: 'rgba(40,20,5,.22)', gw: 1 }, floorCell: .5, wall: { c: [240, 232, 220] } });
  // window above sink
  w.decal([-.75, 1.6, 6.495], [1.5, 0, 0], [0, 1.05, 0], 1, 1, { paint: skyPainter({ stops: [[0, '#6fa3d2'], [.75, '#cfe2ea'], [1, '#fdf2da']],
    sun: [.35, .45, 1], sunR: 600, hills: [['#88a86f', .07, 3], ['#5d8352', .035, 7]] }) }, [0, 1, 0]);
  const bronze = { c: [54, 48, 42] };
  w.box(-.8, 1.55, 6.42, .8, 1.6, 6.5, bronze); w.box(-.8, 2.65, 6.42, .8, 2.7, 6.5, bronze);
  for (const x of [-.8, -.025, .75]) w.box(x, 1.6, 6.44, x + .05, 2.65, 6.5, bronze, { bias: .1 });
  // backsplash tiles
  w.decal([-2.6, .93, 6.49], [5.2, 0, 0], [0, .62, 0], 34, 4, { c: [226, 220, 204], vary: .06, grout: 'rgba(255,255,255,.5)', gw: 1 }, [0, 1, 0]);
  const green = { c: [48, 82, 68] }, greenG = { c: [48, 82, 68], grout: 'rgba(0,0,0,.35)', gw: 2 }, marble = { c: [238, 236, 230] };
  w.box(-2.6, 0, 5.98, 2.6, .1, 6.5, { c: [28, 40, 34] });
  w.box(-2.6, .1, 5.9, 2.6, .88, 6.5, green, { sub: [8, 1, 1], front: greenG });
  w.box(-2.66, .88, 5.84, 2.66, .93, 6.5, marble, { bias: .3, sub: [4, 1, 1] });
  w.box(-2.6, 1.72, 6.12, -.95, 2.62, 6.5, green, { sub: [3, 1, 1], front: greenG });
  w.box(.95, 1.72, 6.12, 2.6, 2.62, 6.5, green, { sub: [3, 1, 1], front: greenG });
  w.box(-.4, .931, 6.0, .4, .936, 6.35, { c: [120, 124, 128] }, { bias: .6 });
  w.cyl(0, 6.4, .02, .93, 1.28, { c: [200, 160, 92] }, { seg: 8, bias: .7 });
  w.box(-.02, 1.24, 6.2, .02, 1.28, 6.42, { c: [200, 160, 92] }, { bias: .8 });
  w.box(-1.95, .931, 6.0, -1.25, .936, 6.4, { c: [22, 22, 24] }, { bias: .6 });
  // tall pantry on right wall
  w.box(2.62, 0, 3.9, 3.2, 2.7, 5.7, green, { sub: [1, 2, 3], side: greenG });
  // island
  w.box(-1.4, .05, 3.02, 1.4, .92, 3.98, green, { sub: [5, 1, 1], front: greenG });
  w.box(-1.52, .92, 2.94, 1.52, .98, 4.06, marble, { bias: .4, sub: [3, 1, 1] });
  w.box(-1.52, 0, 2.94, -1.44, .92, 4.06, marble, { bias: .2 }); w.box(1.44, 0, 2.94, 1.52, .92, 4.06, marble, { bias: .2 });
  w.sprite([.35, .98, 3.5], fruitBowl(), 1.2);
  w.sprite([-.6, .98, 3.55], vase({ h: .55, vh: .28, vw: .15, col: '#e6ddcc', dark: '#948a7a', flower: ['#8c9a5a', '#a8b46e', '#6f7e44'], n: 8 }), 1.2);
  // pendants
  for (const x of [-.8, 0, .8]) {
    w.box(x - .004, 2.2, 3.496, x + .004, 3.1, 3.504, { c: [30, 30, 30] });
    w.cyl(x, 3.5, .17, 1.96, 2.2, { c: [36, 34, 32] }, { seg: 18 });
    w.sprite([x, 1.94, 3.5], glow(1.1, '255,196,125', .85), 60);
  }
  // stools
  for (const x of [-.85, 0, .85]) {
    w.cyl(x, 2.6, .2, .66, .72, { c: [168, 118, 76] }, { bias: .3 });
    for (const [dx, dz] of [[-.12, -.12], [.12, -.12], [-.12, .12], [.12, .12]]) w.box(x + dx - .015, 0, 2.6 + dz - .015, x + dx + .015, .66, 2.6 + dz + .015, { c: [34, 32, 30] });
  }
  w.sprite([-2.85, 0, 5.5], plant(7, { h: 1.6, cols: ['#355f36', '#46733e', '#2a4f2d', '#5b8a48'], leaf: 1.2, pot: '#c9b89f', potDark: '#7f7160' }));
  w.sprite([2.2, .93, 6.2], plant(17, { h: .35, potH: .14, potW: .16, n: 12, leaf: .5, cols: ['#4d7a3e', '#5f8f4b'], pot: '#b2643e', potDark: '#6e3a22' }), 1);
  // artwork on left wall
  w.decal([-3.195, 1.3, 2.4], [0, 0, 1.6], [0, 1.1, 0], 1, 1, { grout: 'rgba(40,30,20,.9)', gw: 6, paint: affinePaint(ctx => {
    ctx.fillStyle = '#efe4cf'; ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = '#d27a4a'; ctx.beginPath(); ctx.arc(.35, .45, .2, 0, 7); ctx.fill();
    ctx.fillStyle = '#2f5a4a'; ctx.fillRect(.52, .15, .3, .55);
    ctx.fillStyle = '#e8b85a'; ctx.beginPath(); ctx.arc(.67, .7, .12, Math.PI, 0); ctx.fill();
  }) }, [0, 1, 3]);
  const sun = sunlight({ dir: norm([.4, -.5, -1]), col: '255,230,180', patchA: .2, beamA: .085, L: 5.5, dust: 60,
    panes: [[[-.75, 1.6, 6.49], [0, 1.6, 6.49], [0, 2.65, 6.49], [-.75, 2.65, 6.49]], [[.03, 1.6, 6.49], [.75, 1.6, 6.49], [.75, 2.65, 6.49], [.03, 2.65, 6.49]]],
    bounds: [[0, -3.2, true], [0, 3.2, false], [2, 0, true], [2, 5.8, false]] });
  w.pre = (ctx, cam, t) => { sun.patch(ctx, cam, t); pool(ctx, cam, [0, .01, 3.5], 2.2, '255,180,110', .12); };
  w.post = (ctx, cam, t) => sun.beams(ctx, cam, t);
  w.cam = u => camPath([[-2.3, 1.75, .5, .5, -.21], [-.9, 1.62, .35, .18, -.17], [.9, 1.58, .5, -.2, -.15], [2.2, 1.52, 1.1, -.55, -.13]], u);
  return w;
}

// ---------- 3. Hall / living room at golden hour
function sceneHall() {
  const Wd = 7.5, Hh = 3.6, D = 7.5;
  const w = new World({ seed: 41, amb: [.3, .27, .27], exposure: 1.15, lights: [
    { p: [0, 1.8, 7.1], c: [1, .78, .52], i: 3.2, r: 3.8 },
    { p: [-3.1, 1.5, 5.6], c: [1, .7, .42], i: 1.2, r: 1.4 },
    { p: [0, 2.6, 3.5], c: [1, .8, .6], i: .7, r: 2.5 },
  ] });
  w.room(Wd, Hh, D, { floor: { c: [190, 146, 102], vary: .09, grout: 'rgba(40,20,5,.2)', gw: 1 }, floorCell: .5, wall: { c: [234, 222, 204] } });
  const panes = [];
  for (const [x0, x1] of [[-3.1, -1.2], [-.95, .95], [1.2, 3.1]]) {
    w.decal([x0, .25, 7.495], [x1 - x0, 0, 0], [0, 2.95, 0], 1, 1, { paint: skyPainter({ stops: [[0, '#5d6f9a'], [.45, '#c98f86'], [.78, '#f2b577'], [1, '#ffd89a']],
      sun: [-.3, .1, 1], sunR: 800, hills: [['#9e7e82', .06, 1.5], ['#6b5560', .03, 3]] }) }, [0, 1, 0]);
    panes.push([[x0, .25, 7.49], [x1, .25, 7.49], [x1, 3.2, 7.49], [x0, 3.2, 7.49]]);
    const br = { c: [48, 40, 36] };
    w.box(x0 - .05, .2, 7.4, x0, 3.25, 7.5, br); w.box(x1, .2, 7.4, x1 + .05, 3.25, 7.5, br);
    w.box(x0 - .05, 3.2, 7.4, x1 + .05, 3.26, 7.5, br); w.box(x0 - .05, .18, 7.36, x1 + .05, .25, 7.5, br);
    w.box(x0, 2.42, 7.42, x1, 2.47, 7.5, br, { bias: .1 });
  }
  const sun = sunlight({ dir: norm([.3, -.55, -1]), col: '255,190,120', patchA: .26, beamA: .075, L: 7, dust: 110, panes,
    bounds: [[0, -3.75, true], [0, 3.75, false], [2, 0, true], [2, 7.5, false]] });
  // ceiling beams
  for (const x of [-2.4, 0, 2.4]) w.box(x - .12, 3.36, 0, x + .12, 3.6, 7.5, { c: [150, 108, 72] });
  // rug
  w.box(-2.3, 0, 2.1, 1.9, .012, 5.2, { c: [178, 96, 66] });
  w.box(-2.1, .012, 2.3, 1.7, .016, 5.0, { c: [232, 220, 198], grout: 'rgba(170,90,60,.35)', gw: 2 }, { sub: [4, 1, 3], bias: .5 });
  // sofa along left wall, facing +x
  const linen = { c: [212, 196, 172] }, terra = { c: [190, 110, 78] };
  w.box(-3.7, 0, 2.45, -2.85, .14, 5.0, { c: [60, 44, 34] });
  w.box(-3.72, .14, 2.4, -2.78, .44, 5.05, linen);
  w.box(-3.74, .14, 2.4, -3.42, .95, 5.05, linen, { bias: .2 });
  w.box(-3.72, .14, 2.4, -2.8, .66, 2.62, linen, { bias: .3 }); w.box(-3.72, .14, 4.83, -2.8, .66, 5.05, linen, { bias: .3 });
  w.box(-3.42, .44, 2.62, -2.84, .58, 3.72, linen, { bias: .5 }); w.box(-3.42, .44, 3.74, -2.84, .58, 4.83, linen, { bias: .5 });
  w.sprite([-3.3, .82, 3.1], pillow(.42, .38, '#d88a5e', '#8e4a2e', .1), 1.1);
  w.sprite([-3.3, .82, 4.35], pillow(.42, .38, '#a9b69a', '#5e6b52', -.1), 1.1);
  w.box(-3.3, .58, 3.8, -2.9, .6, 4.5, terra, { bias: .7 });
  // armchair on right
  w.box(2.3, 0, 3.4, 3.1, .42, 4.3, terra); w.box(2.95, .42, 3.4, 3.15, .95, 4.3, terra, { bias: .2 });
  w.box(2.3, .42, 3.35, 3.1, .62, 3.5, terra, { bias: .3 }); w.box(2.3, .42, 4.2, 3.1, .62, 4.35, terra, { bias: .3 });
  // coffee table
  const walnut = { c: [110, 72, 48] };
  w.cyl(-.5, 3.7, .26, 0, .36, walnut, { seg: 18 }); w.cyl(-.5, 3.7, .6, .36, .42, walnut, { seg: 32, bias: .3 });
  w.box(-.75, .42, 3.5, -.35, .47, 3.8, { c: [46, 72, 88] }, { bias: .7 }); w.box(-.72, .47, 3.52, -.4, .5, 3.77, { c: [226, 214, 190] }, { bias: .8 });
  w.sprite([-.2, .42, 3.85], vase({ h: .35, vh: .2, vw: .12, col: '#3c5a6a', dark: '#1e2e38', flower: ['#e2c9a0', '#cfae7c'], n: 6 }), 1);
  // floor lamp
  w.cyl(-3.1, 5.6, .16, 0, .03, { c: [30, 28, 26] }); w.box(-3.12, .03, 5.58, -3.08, 1.45, 5.62, { c: [30, 28, 26] });
  w.cyl(-3.1, 5.6, .24, 1.4, 1.68, { c: [250, 232, 200], gain: 1.6 }, { seg: 20 });
  w.sprite([-3.1, 1.5, 5.6], glow(1.4, '255,190,120', .7), 60);
  // bookshelf on right wall
  const shelf = { c: [120, 84, 58] };
  const r = rng(404), bookCols = [[182, 92, 64], [58, 86, 100], [220, 200, 160], [90, 110, 80], [200, 150, 70], [140, 60, 50], [230, 222, 206], [60, 60, 70]];
  w.box(3.35, 0, 4.9, 3.75, 2.7, 4.95, shelf); w.box(3.35, 0, 7.2, 3.75, 2.7, 7.25, shelf);
  for (const y of [0, .66, 1.32, 1.98, 2.64]) {
    w.box(3.35, y, 4.95, 3.75, y + .04, 7.2, shelf, { bias: .1 });
    if (y > 2.5) continue;
    let z = 5.0;
    while (z < 7.1) {
      const bw = .035 + r() * .05, bh = .38 + r() * .18;
      if (r() < .1) { z += .15; continue; }
      if (z + bw > 7.15) break;
      w.box(3.42 + r() * .04, y + .04, z, 3.73, y + .04 + bh, z + bw, { c: bookCols[Math.floor(r() * bookCols.length)] }, { bias: .3 });
      z += bw + .004;
    }
  }
  // painting above sofa
  w.decal([-3.745, 1.35, 2.9], [0, 0, 1.7], [0, 1.2, 0], 1, 1, { grout: 'rgba(60,40,20,.95)', gw: 7, paint: affinePaint(ctx => {
    const g = ctx.createLinearGradient(0, 0, 0, 1); g.addColorStop(0, '#f1e3c8'); g.addColorStop(1, '#e8cfa6');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = '#c96a44'; ctx.beginPath(); ctx.moveTo(.1, 0); ctx.lineTo(.1, .45); ctx.arc(.3, .45, .2, Math.PI, 0, true); ctx.lineTo(.5, 0); ctx.fill();
    ctx.fillStyle = '#2d4f5c'; ctx.beginPath(); ctx.arc(.72, .62, .16, 0, 7); ctx.fill();
    ctx.fillStyle = '#e0a84a'; ctx.fillRect(.58, .08, .3, .2);
  }) }, [0, 1, 3]);
  w.sprite([2.9, 0, 6.9], plant(8, { h: 2.0, n: 26, leaf: 1.5, cols: ['#2f5a33', '#3f6b3a', '#4f7d42', '#27492b'], pot: '#ddd2c0', potDark: '#8f8574', potW: .5, potH: .45 }));
  w.sprite([-3.25, 0, 6.9], plant(12, { h: 1.4, n: 20, leaf: 1.2, cols: ['#355f36', '#46733e', '#5b8a48'], pot: '#b8704a', potDark: '#6a3a22' }));
  // paper lantern
  w.box(-.005, 2.9, 3.495, .005, 3.36, 3.505, { c: [40, 40, 40] });
  w.sprite([0, 2.62, 3.5], (ctx, x, y, s, t) => {
    const R = .3 * s, g = ctx.createRadialGradient(x - R * .2, y - R * .2, 0, x, y, R);
    g.addColorStop(0, '#fffaf0'); g.addColorStop(.7, '#ffe6c0'); g.addColorStop(1, '#e8c090');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, R, 0, 7); ctx.fill();
    glow(1.6, '255,200,140', .5)(ctx, x, y, s, t);
  }, 30);
  w.pre = (ctx, cam, t) => sun.patch(ctx, cam, t);
  w.post = (ctx, cam, t) => sun.beams(ctx, cam, t);
  w.cam = u => camPath([[2.5, 1.65, .45, -.62, -.12], [.9, 1.5, .8, -.12, -.06], [-.6, 1.42, 1.2, .3, -.07], [-1.1, 1.4, 1.5, .62, -.08]], u);
  return w;
}

// ---------- 4. Back to the front door
function sceneEntry() {
  const Wd = 3.2, Hh = 3.0, D = 6;
  const w = new World({ seed: 51, amb: [.27, .26, .27], exposure: 1.2, lights: [
    { p: [-.85, 2.0, 5.8], c: [1, .72, .45], i: 1.2, r: 1.2 }, { p: [.85, 2.0, 5.8], c: [1, .72, .45], i: 1.2, r: 1.2 },
    { p: [0, 2.6, 5.9], c: [1, .9, .75], i: 1.4, r: 2.2 }, { p: [0, 2.7, 2.5], c: [1, .85, .7], i: .9, r: 2.2 },
  ] });
  w.room(Wd, Hh, D, { floor: { c: [196, 150, 106], vary: .08, grout: 'rgba(40,20,5,.2)', gw: 1 }, floorCell: .45,
    wall: { c: [236, 226, 210] }, wain: { h: 1.05, mat: { c: [120, 138, 128], grout: 'rgba(0,0,0,.18)', gw: 2 }, cell: .5 } });
  // light beyond the door + transom
  const outside = (ctx, cam) => {
    const a = cam.pw([0, 2.8, 6]), b = cam.pw([0, 0, 6]); if (!a || !b) return;
    const g = ctx.createLinearGradient(0, a[1], 0, b[1]);
    g.addColorStop(0, '#fff8ea'); g.addColorStop(.55, '#ffe6b8'); g.addColorStop(.8, '#cfd9a8'); g.addColorStop(1, '#8fae78');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  };
  w.decal([-.55, 0, 5.995], [1.1, 0, 0], [0, 2.3, 0], 1, 1, { paint: outside }, [0, 1, 0]);
  w.decal([-.55, 2.4, 5.995], [1.1, 0, 0], [0, .38, 0], 2, 1, { paint: outside, grout: 'rgba(30,30,30,1)', gw: 5 }, [0, 1, 0]);
  const trim = { c: [244, 240, 232] };
  w.box(-.72, 0, 5.9, -.55, 2.85, 6, trim); w.box(.55, 0, 5.9, .72, 2.85, 6, trim);
  w.box(-.72, 2.3, 5.9, .72, 2.4, 6, trim, { bias: .1 }); w.box(-.72, 2.78, 5.9, .72, 2.88, 6, trim, { bias: .1 });
  for (const x of [-.95, .95]) { w.cyl(x, 5.95, .06, 1.85, 2.15, { c: [255, 240, 214], gain: 1.5 }, { seg: 10 }); w.sprite([x, 2.0, 5.9], glow(.5, '255,190,120', .6), 60); }
  // runner rug
  w.box(-.5, 0, .8, .5, .012, 5.5, { c: [150, 70, 52] });
  w.box(-.42, .012, .9, .42, .016, 5.4, { c: [226, 208, 176], grout: 'rgba(150,70,52,.45)', gw: 2 }, { sub: [3, 1, 12], bias: .5 });
  // console + mirror on left wall
  const oak = { c: [160, 112, 72] };
  w.box(-1.6, .78, 2.4, -1.22, .83, 3.9, oak, { bias: .2 });
  for (const z of [2.45, 3.82]) w.box(-1.28, 0, z, -1.24, .78, z + .04, oak);
  w.sprite([-1.42, .83, 3.4], vase({ h: .6, vh: .34, vw: .17, col: '#d8c7ad', dark: '#8a7962', flower: ['#e9dcc0', '#d4c09a', '#c9ad80'], n: 9 }), 1);
  w.sprite([-1.42, .83, 2.75], candle(), 1);
  w.disc([-1.595, 1.75, 3.15], 'x', .55, { c: [200, 160, 92] }, 1, .1);
  w.disc([-1.585, 1.75, 3.15], 'x', .5, { paint: affinePaint(ctx => {
    const g = ctx.createLinearGradient(1, 0, 0, 1);
    g.addColorStop(0, '#cfd6d4'); g.addColorStop(.5, '#8f9a98'); g.addColorStop(.55, '#dfe5e3'); g.addColorStop(1, '#5f6a68');
    ctx.fillStyle = g; ctx.fillRect(-2, -2, 5, 5);
  }) }, 1, .3);
  // bench right
  w.box(1.1, .42, 3.0, 1.55, .48, 4.3, oak, { bias: .2 });
  for (const z of [3.05, 4.2]) w.box(1.12, 0, z, 1.53, .42, z + .05, oak);
  w.box(1.18, .48, 3.2, 1.5, .62, 3.7, { c: [196, 170, 128], grout: 'rgba(0,0,0,.15)' }, { sub: [1, 2, 3], bias: .4 });
  for (const z of [1.8, 2.2]) { w.cyl(1.57, z, .025, 1.7, 1.73, { c: [200, 160, 92] }, { seg: 8 }); }
  w.box(1.5, 1.2, 1.7, 1.58, 1.72, 1.92, { c: [150, 160, 140] }, { bias: .3 });
  w.sprite([1.15, 0, 5.55], plant(23, { h: 1.3, cols: ['#355f36', '#46733e', '#5b8a48'], pot: '#2f2f2f', potDark: '#111' }));
  w.cyl(0, 2.5, .2, 2.85, 3.0, { c: [248, 240, 226], gain: 1.4 });
  w.sprite([0, 2.86, 2.5], glow(1.2, '255,210,160', .5), 60);
  const openK = t => sstep(.46, .78, t);
  w.dyn = t => w.capture(() => {
    const a = openK(t) * 1.5, U = [Math.cos(a) * 1.1, 0, -Math.sin(a) * 1.1], Wv = [Math.sin(a) * .06, 0, Math.cos(a) * .06];
    w.obox([-.55, 0, 5.94], U, [0, 2.3, 0], Wv, { c: [36, 70, 84] }, { sub: [2, 3, 1], front: { c: [36, 70, 84], grout: 'rgba(0,0,0,.35)', gw: 3 }, back: { c: [36, 70, 84], grout: 'rgba(0,0,0,.35)', gw: 3 }, bias: .5 });
    w.sprite(add(add([-.55, 1.05, 5.9], mul(U, .9)), [0, 0, -.02]), knob(.032), 1);
  });
  const doorSun = sunlight({ dir: norm([.12, -.3, -1]), col: '255,236,200', patchA: .35, beamA: .14, L: 6, dust: 80,
    panes: [[[-.55, 0.01, 5.99], [.55, 0.01, 5.99], [.55, 2.3, 5.99], [-.55, 2.3, 5.99]]],
    bounds: [[0, -1.6, true], [0, 1.6, false], [2, 0, true], [2, 6, false]] });
  w.pre = (ctx, cam, t) => { const k = openK(t); if (k > 0) doorSun.patch(ctx, cam, t, k); };
  w.post = (ctx, cam, t) => { const k = openK(t); if (k > 0) doorSun.beams(ctx, cam, t, k); };
  w.cam = u => camPath([[.35, 1.6, .3, -.12, -.06], [.1, 1.58, 1.4, -.03, -.03], [0, 1.56, 2.8, 0, 0], [0, 1.55, 3.7, 0, .01], [0, 1.55, 4.3, 0, .02]], u);
  return w;
}

// ================================================================= timeline
const SCENES = [
  { make: sceneExterior, t0: 0, t1: 6.4, title: null },
  { make: sceneBath, t0: 5.4, t1: 13.2, n: '01', title: 'The Bathroom', sub: 'Sage zellige · morning light · a freestanding tub' },
  { make: sceneKitchen, t0: 12.2, t1: 20.6, n: '02', title: 'The Kitchen', sub: 'Forest-green joinery · marble · three brass pendants' },
  { make: sceneHall, t0: 19.6, t1: 28.4, n: '03', title: 'The Hall', sub: 'Golden hour · oak beams · a wall of windows' },
  { make: sceneEntry, t0: 27.4, t1: DUR, n: '04', title: 'The Front Door', sub: 'And back where we began' },
];
SCENES.forEach(s => { s.world = s.make(); });

// ================================================================= compositing
const canvas = document.getElementById('film');
const ctx = canvas.getContext('2d');
const buf = document.createElement('canvas'); buf.width = W; buf.height = H;
const bctx = buf.getContext('2d');
const small = document.createElement('canvas'); small.width = 240; small.height = 135;
const sctx = small.getContext('2d');
const mid = document.createElement('canvas'); mid.width = 480; mid.height = 270;
const mctx = mid.getContext('2d');

const grain = document.createElement('canvas'); grain.width = grain.height = 256;
{ const g = grain.getContext('2d'), id = g.createImageData(256, 256);
  for (let i = 0; i < id.data.length; i += 4) { const v = Math.random() * 255; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; }
  g.putImageData(id, 0, 0); }
const grainPat = ctx.createPattern(grain, 'repeat');
const vign = document.createElement('canvas'); vign.width = W; vign.height = H;
{ const v = vign.getContext('2d'), g = v.createRadialGradient(W / 2, H / 2, H * .35, W / 2, H / 2, W * .72);
  g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(10,6,2,.62)'); v.fillStyle = g; v.fillRect(0, 0, W, H); }

function renderScene(c, s, t) {
  const u = clamp((t - s.t0) / (s.t1 - s.t0));
  const uu = .45 * u + .55 * easeSine(u);
  const cam = s.world.cam(uu);
  cam.yaw += Math.sin(t * .63) * .004; cam.pitch += Math.sin(t * .87 + 1) * .003;
  renderWorld(c, s.world, cam, uu);
}

const BAR = 92;
function drawText(c, t) {
  c.save();
  c.textBaseline = 'alphabetic';
  // intro title
  const ia = sstep(.8, 2, t) * (1 - sstep(4.2, 5.2, t));
  if (ia > 0) {
    c.globalAlpha = ia; c.textAlign = 'center'; c.fillStyle = '#fff6e6';
    c.shadowColor = 'rgba(0,0,0,.45)'; c.shadowBlur = 30;
    c.font = '500 26px Inter, sans-serif'; c.letterSpacing = '10px';
    c.fillText('A HOME TOUR', W / 2, H * .3 - 70);
    c.letterSpacing = '0px'; c.font = 'italic 400 128px "Cormorant Garamond", serif';
    c.fillText('Maison Lumière', W / 2, H * .3 + 50);
    c.font = '400 24px Inter, sans-serif'; c.globalAlpha = ia * .8;
    c.fillText('rendered entirely in JavaScript', W / 2, H * .3 + 110);
  }
  // room captions
  for (const s of SCENES) {
    if (!s.title) continue;
    const a = sstep(s.t0 + 1.0, s.t0 + 2.0, t) * (1 - sstep(s.t1 - 2.2, s.t1 - 1.2, t));
    if (a <= 0) continue;
    const slide = (1 - sstep(s.t0 + 1.0, s.t0 + 2.4, t)) * 30;
    c.globalAlpha = a; c.textAlign = 'left'; c.shadowColor = 'rgba(0,0,0,.55)'; c.shadowBlur = 24;
    const x = 110, y = H - BAR - 70;
    c.fillStyle = '#f3c58a'; c.font = '500 22px Inter, sans-serif'; c.letterSpacing = '6px';
    c.fillText(`ROOM ${s.n}`, x + slide, y - 98);
    c.letterSpacing = '0px'; c.fillStyle = '#fff8ec'; c.font = 'italic 400 92px "Cormorant Garamond", serif';
    c.fillText(s.title, x + slide * .6, y - 18);
    c.font = '400 24px Inter, sans-serif'; c.fillStyle = 'rgba(255,244,228,.85)';
    c.fillText(s.sub, x + slide * .3, y + 22);
    c.fillStyle = '#f3c58a'; c.fillRect(x, y - 88, 60 * a, 2);
  }
  c.restore();
}

function frame(t) {
  t = clamp(t, 0, DUR);
  const act = SCENES.filter(s => t >= s.t0 && t <= s.t1);
  if (!act.length) act.push(SCENES[SCENES.length - 1]);
  renderScene(ctx, act[0], t);
  if (act[1]) {
    renderScene(bctx, act[1], t);
    ctx.globalAlpha = easeSine(clamp((t - act[1].t0) / (act[0].t1 - act[1].t0)));
    ctx.drawImage(buf, 0, 0); ctx.globalAlpha = 1;
  }
  // bloom: downsample + upscale, screen blend
  mctx.drawImage(canvas, 0, 0, 480, 270); sctx.drawImage(mid, 0, 0, 240, 135);
  ctx.save();
  ctx.globalCompositeOperation = 'screen'; ctx.globalAlpha = .28; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, 0, 0, W, H);
  // warm grade
  ctx.globalCompositeOperation = 'soft-light'; ctx.globalAlpha = .18; ctx.fillStyle = '#ffb070'; ctx.fillRect(0, 0, W, H);
  ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = 1;
  ctx.drawImage(vign, 0, 0);
  // grain
  ctx.globalCompositeOperation = 'overlay'; ctx.globalAlpha = .09;
  ctx.translate((Math.random() * 256) | 0, (Math.random() * 256) | 0);
  ctx.fillStyle = grainPat; ctx.fillRect(-256, -256, W + 256, H + 256);
  ctx.restore();
  // fade in from black, fade out to cream
  const fin = 1 - sstep(0, 1.4, t);
  if (fin > 0) { ctx.fillStyle = `rgba(0,0,0,${fin})`; ctx.fillRect(0, 0, W, H); }
  const fout = sstep(DUR - 4.2, DUR - 2.6, t);
  if (fout > 0) { ctx.fillStyle = `rgba(247,239,226,${fout})`; ctx.fillRect(0, 0, W, H); }
  drawText(ctx, t);
  // end card
  const ea = sstep(DUR - 2.8, DUR - 1.8, t);
  if (ea > 0) {
    ctx.save(); ctx.globalAlpha = ea; ctx.textAlign = 'center'; ctx.fillStyle = '#2a211a';
    ctx.font = 'italic 400 120px "Cormorant Garamond", serif'; ctx.fillText('Welcome home.', W / 2, H / 2 + 20);
    ctx.font = '500 22px Inter, sans-serif'; ctx.letterSpacing = '8px'; ctx.fillStyle = '#8a7560';
    ctx.fillText('EXPERIMENTAL FILM · JAVASCRIPT', W / 2, H / 2 + 100);
    ctx.restore();
  }
  // letterbox
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, BAR); ctx.fillRect(0, H - BAR, W, BAR);
}

// ================================================================= audio: generative pad + bells
const CHORDS = [
  { t: 0, e: 6.2, n: [50, 57, 61, 66, 69] },
  { t: 5.8, e: 13, n: [47, 54, 57, 62, 66] },
  { t: 12.6, e: 20.4, n: [43, 50, 54, 59, 62] },
  { t: 20, e: 28.2, n: [40, 47, 55, 59, 66] },
  { t: 27.8, e: DUR, n: [50, 57, 61, 64, 66, 69] },
];
class Score {
  start(offset) {
    const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
    const ac = this.ac = new AC();
    const master = ac.createGain(); master.gain.value = .0001;
    master.gain.exponentialRampToValueAtTime(.8, ac.currentTime + 1.2);
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1700;
    const dl = ac.createDelay(1); dl.delayTime.value = .41;
    const fb = ac.createGain(); fb.gain.value = .45;
    const dlf = ac.createBiquadFilter(); dlf.type = 'lowpass'; dlf.frequency.value = 1400;
    lp.connect(master); lp.connect(dl); dl.connect(dlf); dlf.connect(fb); fb.connect(dl); dlf.connect(master);
    master.connect(ac.destination);
    this.dest = ac.createMediaStreamDestination(); master.connect(this.dest);
    const now = ac.currentTime + .05, hz = m => 440 * Math.pow(2, (m - 69) / 12), r = rng(9);
    for (const ch of CHORDS) {
      const s = ch.t - offset, e = ch.e - offset; if (e <= 0) continue;
      const st = Math.max(0, s), att = s < 0 ? .6 : 2.2;
      ch.n.forEach((m, i) => {
        for (const det of [-5, 5]) {
          const o = ac.createOscillator(); o.type = i === 0 ? 'sine' : 'triangle'; o.frequency.value = hz(m); o.detune.value = det;
          const g = ac.createGain(), peak = .032 / (1 + i * .3);
          g.gain.setValueAtTime(0, now + st); g.gain.linearRampToValueAtTime(peak, now + st + att);
          g.gain.setValueAtTime(peak, now + Math.max(st + att, e - 1.2)); g.gain.linearRampToValueAtTime(0, now + e + 1.4);
          o.connect(g); g.connect(lp); o.start(now + st); o.stop(now + e + 1.6);
        }
      });
      for (let bt = ch.t + .6, k = 0; bt < ch.e - .4; bt += .62, k++) {
        if (bt - offset < 0 || r() < .3) continue;
        const o = ac.createOscillator(); o.type = 'sine';
        o.frequency.value = hz(ch.n[(k * 3 + (r() * 2 | 0)) % ch.n.length] + 24);
        const g = ac.createGain(), at = now + bt - offset;
        g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(.022, at + .01); g.gain.exponentialRampToValueAtTime(.0001, at + 2.2);
        o.connect(g); g.connect(lp); o.start(at); o.stop(at + 2.3);
      }
    }
  }
  stop() { if (this.ac) { this.ac.close(); this.ac = null; this.dest = null; } }
}

// ================================================================= player
const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const score = new Score();
let playing = false, t0 = 0, offset = 0, soundOn = false, recorder = null;
const now = () => playing ? offset + (performance.now() - t0) / 1000 : offset;
const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
$('dur').textContent = fmt(DUR);

function play() { if (playing) return; if (offset >= DUR) offset = 0; playing = true; t0 = performance.now(); if (soundOn) score.start(offset); $('play').textContent = '❚❚'; }
function pause() { if (!playing) return; offset = now(); playing = false; score.stop(); $('play').textContent = '▶'; }
function seek(s) { const was = playing; pause(); offset = clamp(s, 0, DUR); if (was) play(); }

function tick() {
  let t = now();
  if (t >= DUR) {
    if (recorder) { offset = DUR; playing = false; score.stop(); recorder.stop(); }
    else { offset = 0; t0 = performance.now(); t = 0; if (soundOn) { score.stop(); score.start(0); } }
  }
  frame(t);
  $('time').textContent = fmt(t);
  if (!scrubbing) $('scrub').value = Math.round(t / DUR * 1000);
  requestAnimationFrame(tick);
}

let scrubbing = false;
$('scrub').addEventListener('input', e => { scrubbing = true; seek(e.target.value / 1000 * DUR); });
$('scrub').addEventListener('change', () => { scrubbing = false; });
$('play').onclick = () => playing ? pause() : play();
$('sound').onclick = () => {
  soundOn = !soundOn; $('sound').textContent = `Sound: ${soundOn ? 'on' : 'off'}`;
  if (soundOn && playing) score.start(now()); else score.stop();
};
$('bigplay').onclick = () => {
  $('bigplay').classList.add('hidden');
  soundOn = true; $('sound').textContent = 'Sound: on';
  pause(); offset = 0; play();
};

$('export').onclick = () => {
  if (recorder) return;
  if (!window.MediaRecorder || !canvas.captureStream) { $('status').textContent = 'This browser cannot record canvas video.'; return; }
  const mime = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find(m => MediaRecorder.isTypeSupported(m));
  $('bigplay').classList.add('hidden');
  pause(); offset = 0; soundOn = true; $('sound').textContent = 'Sound: on';
  play();
  const stream = canvas.captureStream(60);
  if (score.dest) score.dest.stream.getAudioTracks().forEach(tr => stream.addTrack(tr));
  const chunks = [];
  recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 16e6 });
  recorder.ondataavailable = e => e.data.size && chunks.push(e.data);
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: mime }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `maison-lumiere-home-tour.${mime.includes('mp4') ? 'mp4' : 'webm'}`; a.click();
    $('status').textContent = 'Done: your video has been downloaded.'; recorder = null;
  };
  recorder.start(250);
  $('status').textContent = 'Recording in real time… keep this tab visible (about 36 seconds).';
};

document.fonts.ready.then(() => {
  if (params.has('t')) { offset = parseFloat(params.get('t')); frame(offset); $('bigplay').classList.add('hidden'); return; }
  play();
  requestAnimationFrame(tick);
});
})();
