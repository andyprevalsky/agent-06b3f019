//! Gray-Scott reaction-diffusion on a wrapping grid, rendered to RGBA in linear
//! memory. No dependencies and no wasm-bindgen: JavaScript calls these plain C-ABI
//! exports and reads the pixel buffer straight out of `memory`.
//!
//! Build: `bash build.sh` (cargo build --release --target wasm32-unknown-unknown).

pub struct Sim {
    w: usize,
    h: usize,
    u: Vec<f32>,
    v: Vec<f32>,
    nu: Vec<f32>,
    nv: Vec<f32>,
    rgba: Vec<u8>,
}

/// Small deterministic PRNG so every run starts from the same seed pattern.
fn xorshift(state: &mut u32) -> u32 {
    let mut x = *state;
    x ^= x << 13;
    x ^= x >> 17;
    x ^= x << 5;
    *state = x;
    x
}

fn seed_spot(sim: &mut Sim, cx: usize, cy: usize, r: usize) {
    let (w, h) = (sim.w, sim.h);
    for dy in 0..=2 * r {
        for dx in 0..=2 * r {
            let ox = dx as isize - r as isize;
            let oy = dy as isize - r as isize;
            if ox * ox + oy * oy > (r * r) as isize {
                continue;
            }
            let x = (cx as isize + ox).rem_euclid(w as isize) as usize;
            let y = (cy as isize + oy).rem_euclid(h as isize) as usize;
            let i = y * w + x;
            sim.u[i] = 0.5;
            sim.v[i] = 0.25;
        }
    }
}

/// Allocate a w x h simulation; returns an opaque handle for the other exports.
#[no_mangle]
pub extern "C" fn sim_new(w: u32, h: u32, seed: u32) -> *mut Sim {
    let (w, h) = (w.max(8) as usize, h.max(8) as usize);
    let n = w * h;
    let mut sim = Box::new(Sim {
        w,
        h,
        u: vec![1.0; n],
        v: vec![0.0; n],
        nu: vec![0.0; n],
        nv: vec![0.0; n],
        rgba: vec![255; n * 4],
    });
    let mut state = seed | 1;
    for _ in 0..36 {
        let x = xorshift(&mut state) as usize % w;
        let y = xorshift(&mut state) as usize % h;
        let r = 3 + xorshift(&mut state) as usize % 7;
        seed_spot(&mut sim, x, y, r);
    }
    Box::into_raw(sim)
}

/// Advance `iterations` explicit-Euler steps with feed/kill rates.
#[no_mangle]
pub extern "C" fn sim_step(sim: *mut Sim, iterations: u32, feed: f32, kill: f32) {
    let sim = unsafe { &mut *sim };
    let (w, h) = (sim.w, sim.h);
    let (du, dv) = (1.0f32, 0.5f32);
    for _ in 0..iterations {
        for y in 0..h {
            let ym = if y == 0 { h - 1 } else { y - 1 } * w;
            let yp = if y + 1 == h { 0 } else { y + 1 } * w;
            let yc = y * w;
            // Row slices let the compiler drop most bounds checks in the hot loop.
            let (uc, um, up) = (&sim.u[yc..yc + w], &sim.u[ym..ym + w], &sim.u[yp..yp + w]);
            let (vc, vm, vp) = (&sim.v[yc..yc + w], &sim.v[ym..ym + w], &sim.v[yp..yp + w]);
            let (nu, nv) = (&mut sim.nu[yc..yc + w], &mut sim.nv[yc..yc + w]);
            for x in 0..w {
                let xm = if x == 0 { w - 1 } else { x - 1 };
                let xp = if x + 1 == w { 0 } else { x + 1 };
                let (u, v) = (uc[x], vc[x]);
                // 9-point Laplacian: 0.2 per edge neighbour, 0.05 per corner.
                let lap_u = 0.2 * (uc[xm] + uc[xp] + um[x] + up[x])
                    + 0.05 * (um[xm] + um[xp] + up[xm] + up[xp])
                    - u;
                let lap_v = 0.2 * (vc[xm] + vc[xp] + vm[x] + vp[x])
                    + 0.05 * (vm[xm] + vm[xp] + vp[xm] + vp[xp])
                    - v;
                let uvv = u * v * v;
                nu[x] = (u + du * lap_u - uvv + feed * (1.0 - u)).clamp(0.0, 1.0);
                nv[x] = (v + dv * lap_v + uvv - (kill + feed) * v).clamp(0.0, 1.0);
            }
        }
        std::mem::swap(&mut sim.u, &mut sim.nu);
        std::mem::swap(&mut sim.v, &mut sim.nv);
    }
}

/// Seed chemical at (x, y), e.g. under the pointer.
#[no_mangle]
pub extern "C" fn sim_poke(sim: *mut Sim, x: u32, y: u32, r: u32) {
    let sim = unsafe { &mut *sim };
    let (cx, cy) = (x as usize % sim.w, y as usize % sim.h);
    seed_spot(sim, cx, cy, r.clamp(1, 16) as usize);
}

/// Colour the grid into the RGBA buffer and return its address in linear memory.
/// `hue` (0..1) slowly rotates the palette.
#[no_mangle]
pub extern "C" fn sim_render(sim: *mut Sim, hue: f32) -> *const u8 {
    let sim = unsafe { &mut *sim };
    let shift = hue.fract() * std::f32::consts::TAU;
    let (cs, sn) = (shift.cos(), shift.sin());
    for i in 0..sim.w * sim.h {
        let t = (sim.v[i] * 3.2).clamp(0.0, 1.0);
        let e = t * t * (3.0 - 2.0 * t);
        // Midnight → rose → warm white, rotated a little in the a/b plane.
        let (a, b) = (0.55 * e - 0.1, 0.25 - 0.45 * e);
        let (a, b) = (a * cs - b * sn, a * sn + b * cs);
        let l = 0.06 + 0.9 * e;
        let r = l + 0.9 * a;
        let g = l - 0.35 * a - 0.35 * b;
        let bl = l + 0.9 * b;
        let o = i * 4;
        sim.rgba[o] = (r.clamp(0.0, 1.0) * 255.0) as u8;
        sim.rgba[o + 1] = (g.clamp(0.0, 1.0) * 255.0) as u8;
        sim.rgba[o + 2] = (bl.clamp(0.0, 1.0) * 255.0) as u8;
    }
    sim.rgba.as_ptr()
}
