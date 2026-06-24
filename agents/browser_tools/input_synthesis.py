"""Human input synthesis primitives for browser automation.

System context:
browser action -> BrowserHumanizer -> synthesized samples -> Playwright Input domain
                                      |
                                      +-> optional cursor observer for replay overlays

The keyboard timing path uses the vendored MIMIC-LOGICS Keyboard-Synthesizer
keycap package. The mouse repository publishes the MIMIC paper but no mouse
runtime source, so the mouse path implements the paper's Sigma-Lognormal model:
Eq. 1 for velocity, Eq. 2 for the 2D trajectory, Eq. 3 for angular progress,
plus the browser adaptation rules for polling frequency, repeated coordinates,
screen bounds, and click dwell timing.
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass
from typing import List, Optional, Tuple

import numpy as np

from keycap import Controller, Plant

Point = Tuple[float, float]

CLICK_DURATION_MEAN_MS = 85.0
CLICK_DURATION_SD_MS = 14.8148148
CLICK_DURATION_LOWER_FENCE_MS = 55.0
CLICK_DURATION_UPPER_FENCE_MS = 135.0
MIMIC_MIN_VELOCITY_PX_PER_S = 300.0
MIMIC_MAX_VELOCITY_PX_PER_S = 1500.0
IDLE_MOUSE_RADIUS_PX = 7.0


@dataclass(frozen=True)
class MouseSample:
    x: int
    y: int
    delay_s: float


@dataclass(frozen=True)
class KeyStrokeTiming:
    dwell_s: float
    interval_s: float


def _distance(a: Point, b: Point) -> float:
    return math.hypot(b[0] - a[0], b[1] - a[1])


def _build_mouse_stops(start: Point, end: Point, rng: random.Random, stop_count: Optional[int]) -> List[Point]:
    distance = _distance(start, end)
    if distance < 2:
        return [end]
    if stop_count is None:
        stop_count = 0
        if distance > 220 and rng.random() < 0.35:
            stop_count += 1
        if distance > 520 and rng.random() < 0.25:
            stop_count += 1

    stops: List[Point] = []
    dx = end[0] - start[0]
    dy = end[1] - start[1]
    angle = math.atan2(dy, dx)
    perp = angle + math.pi / 2
    for i in range(stop_count):
        ratio = (i + 1) / (stop_count + 1)
        lateral = rng.uniform(-0.055, 0.055) * distance
        longitudinal = rng.uniform(-0.025, 0.025) * distance
        stops.append(
            (
                start[0] + dx * ratio + longitudinal * math.cos(angle) + lateral * math.cos(perp),
                start[1] + dy * ratio + longitudinal * math.sin(angle) + lateral * math.sin(perp),
            )
        )
    stops.append(end)
    return stops


def _normal_sample_above(rng: random.Random, mean: float, sd: float, lower: float, attempts: int = 80) -> float:
    for _ in range(attempts):
        value = rng.gauss(mean, sd)
        if value >= lower:
            return value
    return lower


def _lognormal_lambda(t: float, t0: float, mu: float, sigma: float) -> float:
    dt = max(1e-6, t - t0)
    return math.exp(-((math.log(dt) - mu) ** 2) / (2 * sigma**2)) / (dt * sigma * math.sqrt(2 * math.pi))


def _sigma_lognormal_phi(t: float, t0: float, mu: float, sigma: float, theta_s: float, theta_e: float) -> float:
    dt = max(1e-6, t - t0)
    z = (math.log(dt) - mu) / (sigma * math.sqrt(2))
    return theta_s + ((theta_e - theta_s) / 2) * (1 + math.erf(z))


def _normalize_angle(angle: float) -> float:
    return ((angle + math.pi) % (2 * math.pi)) - math.pi


def _link_segment_endpoints(
    raw_points: List[Tuple[float, float, float]],
    start: Point,
    end: Point,
) -> List[Tuple[float, float, float]]:
    if len(raw_points) <= 1:
        return raw_points

    start_error_x = start[0] - raw_points[0][1]
    start_error_y = start[1] - raw_points[0][2]
    end_error_x = end[0] - raw_points[-1][1]
    end_error_y = end[1] - raw_points[-1][2]
    adjusted = []
    last_t = max(1e-6, raw_points[-1][0])
    for t, x, y in raw_points:
        ratio = t / last_t
        adjusted.append(
            (
                t,
                x + start_error_x * (1 - ratio) + end_error_x * ratio,
                y + start_error_y * (1 - ratio) + end_error_y * ratio,
            )
        )
    return adjusted


def _sampled_motion_stats(points: List[Tuple[float, float, float]]) -> Tuple[float, float]:
    max_step = 0.0
    max_velocity = 0.0
    for previous, current in zip(points, points[1:]):
        dt = max(1e-6, current[0] - previous[0])
        step = math.hypot(current[1] - previous[1], current[2] - previous[2])
        max_step = max(max_step, step)
        max_velocity = max(max_velocity, step / dt)
    return max_step, max_velocity


def synthesize_click_delay_ms(rng: Optional[random.Random] = None) -> int:
    """Sample a mouse click dwell using the paper's Section 3.7 distribution."""
    rng = rng or random.Random()
    dwell_ms = rng.gauss(CLICK_DURATION_MEAN_MS, CLICK_DURATION_SD_MS)
    dwell_ms = max(CLICK_DURATION_LOWER_FENCE_MS, min(CLICK_DURATION_UPPER_FENCE_MS, dwell_ms))
    return int(round(dwell_ms))


def _sigma_lognormal_segment(
    start: Point,
    end: Point,
    *,
    screen: Tuple[int, int],
    duration_s: float,
    frequency_mean_hz: float,
    snr: float,
    rng: random.Random,
) -> List[MouseSample]:
    """Generate one Sigma-Lognormal stroke using the paper's Eq. 1-3."""

    dx = end[0] - start[0]
    dy = end[1] - start[1]
    distance = max(1.0, math.hypot(dx, dy))
    direction = math.atan2(dy, dx)
    width, height = screen

    best: List[Tuple[float, float, float]] = []
    for _ in range(180):
        sigma = rng.uniform(0.1, 3.0)
        t0 = -_normal_sample_above(rng, 0.05, 0.02, 0.001)
        # Keep final angle convergence high enough to link the virtual target.
        mu_upper = math.log(duration_s - t0) - 1.8 * sigma * math.sqrt(2)
        mu = rng.uniform(-3.0, min(3.0, mu_upper))
        k_final = 0.5 * (1 + math.erf((math.log(duration_s - t0) - mu) / (sigma * math.sqrt(2))))
        if k_final <= 0.05:
            continue

        beta = rng.choice([-1, 1]) * rng.uniform(0.12, min(0.82, max(0.16, k_final * 1.25)))
        theta_delta = beta / k_final
        if abs(theta_delta) < 0.2:
            continue
        chord_mid = direction
        theta_s = _normalize_angle(chord_mid - beta / 2)
        theta_e = theta_s + theta_delta
        if abs(_normalize_angle(theta_e) - theta_s) < 0.2:
            continue

        chord = 2 * math.sin(beta / 2)
        if abs(chord) < 1e-5:
            continue
        d_param = abs(distance * theta_delta / chord)
        if d_param <= 0:
            continue

        peak_t = t0 + math.exp(-(sigma**2) + mu)
        peak_velocity = d_param * _lognormal_lambda(peak_t, t0, mu, sigma)
        if peak_velocity > MIMIC_MAX_VELOCITY_PX_PER_S:
            scale = peak_velocity / rng.uniform(MIMIC_MIN_VELOCITY_PX_PER_S, MIMIC_MAX_VELOCITY_PX_PER_S)
            duration_candidate = min(1.6, max(duration_s, duration_s * math.sqrt(scale)))
        elif peak_velocity < MIMIC_MIN_VELOCITY_PX_PER_S:
            duration_candidate = max(0.18, duration_s * rng.uniform(0.7, 0.9))
        else:
            duration_candidate = duration_s

        sample_count = max(5, int(duration_candidate * max(12, frequency_mean_hz)))
        times = np.linspace(0, duration_candidate, sample_count)
        raw_points: List[Tuple[float, float, float]] = []
        for raw_t in times:
            t = float(raw_t)
            phi = _sigma_lognormal_phi(t, t0, mu, sigma, theta_s, theta_e)
            x = start[0] + (d_param / theta_delta) * (math.sin(phi) - math.sin(theta_s))
            y = start[1] + (d_param / theta_delta) * (-math.cos(phi) + math.cos(theta_s))
            raw_points.append((t, x, y))

        if not raw_points:
            continue
        raw_points = _link_segment_endpoints(raw_points, start, end)
        max_step, max_sampled_velocity = _sampled_motion_stats(raw_points)
        step_ceiling = max(28.0, min(58.0, distance * 0.075))
        if max_sampled_velocity > MIMIC_MAX_VELOCITY_PX_PER_S or max_step > step_ceiling:
            continue

        end_error = math.hypot(raw_points[-1][1] - end[0], raw_points[-1][2] - end[1])
        if best and end_error >= math.hypot(best[-1][1] - end[0], best[-1][2] - end[1]):
            continue
        best = raw_points
        if end_error < max(2.0, distance * 0.02):
            break

    if not best:
        best = [(0.0, start[0], start[1]), (duration_s, end[0], end[1])]

    # Force exact endpoint linkage; Eq. 2 approaches the virtual endpoints, but browser
    # clicks need the first and final coordinates to match the real cursor path exactly.
    best = _link_segment_endpoints(best, start, end)

    if len(best) > 2 and snr > 0:
        xs = np.array([p[1] for p in best], dtype=float)
        ys = np.array([p[2] for p in best], dtype=float)
        sx = float(np.mean(xs * xs))
        sy = float(np.mean(ys * ys))
        delta_t = max(1e-6, best[-1][0] - best[0][0])
        na_x = math.sqrt(max(0.0, sx / snr) / delta_t) * 0.01
        na_y = math.sqrt(max(0.0, sy / snr) / delta_t) * 0.01
        noisy = []
        for index, (t, x, y) in enumerate(best):
            if index in (0, len(best) - 1):
                noisy.append((t, x, y))
            else:
                noisy.append((t, x + rng.gauss(0, na_x), y + rng.gauss(0, na_y)))
        best = noisy

    samples: List[MouseSample] = []
    frequency_mean_hz = max(12, min(140, frequency_mean_hz))
    previous = None
    repeat_count = 0
    for index, (t, x, y) in enumerate(best):
        bounded_x = int(round(max(0, min(width - 1, x))))
        bounded_y = int(round(max(0, min(height - 1, y))))
        current = (bounded_x, bounded_y)
        if current == previous:
            repeat_count += 1
            if repeat_count > 3 and index != len(best) - 1:
                continue
        else:
            repeat_count = 1
        previous = current

        if index == 0:
            delay = max(0.001, rng.gauss(1 / frequency_mean_hz, 0.001))
        else:
            delay = max(0.001, t - best[index - 1][0])
        samples.append(MouseSample(bounded_x, bounded_y, delay))

    if not samples or (samples[-1].x, samples[-1].y) != (int(end[0]), int(end[1])):
        samples.append(MouseSample(int(end[0]), int(end[1]), max(0.001, 1 / frequency_mean_hz)))
    return samples


def synthesize_mouse_path(
    start: Point,
    end: Point,
    *,
    screen: Tuple[int, int] = (1280, 800),
    frequency_hz: int = 90,
    duration_s: Optional[float] = None,
    snr: float = 55,
    stop_count: Optional[int] = None,
    rng: Optional[random.Random] = None,
) -> List[MouseSample]:
    """Create a bounded Sigma-Lognormal mouse trajectory with per-sample delays."""

    rng = rng or random.Random()
    distance = _distance(start, end)
    if distance < 1:
        return []

    if duration_s is None:
        duration_s = _normal_sample_above(rng, 0.75, 0.3, 0.4)
    frequency_mean = max(12, min(140, float(frequency_hz) + rng.gauss(0, 3)))

    stops = _build_mouse_stops(start, end, rng, stop_count)
    points = [start] + stops
    lengths = [max(1.0, _distance(points[index], points[index + 1])) for index in range(len(points) - 1)]
    total_length = sum(lengths)
    samples: List[MouseSample] = []

    for index in range(len(points) - 1):
        weight = lengths[index] / total_length
        segment_duration = max(0.1, duration_s * weight)
        frequency_mean = max(50, min(140, rng.gauss(frequency_mean, 1)))
        segment = _sigma_lognormal_segment(
            points[index],
            points[index + 1],
            screen=screen,
            duration_s=segment_duration,
            frequency_mean_hz=frequency_mean,
            snr=snr,
            rng=rng,
        )
        if samples and segment and (segment[0].x, segment[0].y) == (samples[-1].x, samples[-1].y):
            segment = segment[1:]
        samples.extend(segment)

    # Inject per-sample speed variation. A clean Sigma-Lognormal profile can yield
    # velocityVariance < 0.02 (px/ms)^2 on slower/shorter moves, which behavioral
    # biometrics flag as "mouse velocity too consistent". Real hand movement varies
    # speed mainly on the LOW end — brief hesitations / decelerations — never with
    # super-fast jumps (those are themselves a bot tell, guarded by the
    # max-velocity invariant). So scatter velocities by occasionally LENGTHENING a
    # sample's delay (slowing it down): velocity = distance/dt only ever drops,
    # the peak velocity is untouched, and a handful of low-velocity outliers is
    # enough to clear the variance floor.
    if len(samples) > 3:
        varied: List[MouseSample] = []
        for sample in samples:
            factor = 1.0
            if rng.random() < 0.18:
                factor = rng.uniform(1.4, 2.2)  # brief hesitation -> low-velocity outlier
            varied.append(MouseSample(sample.x, sample.y, sample.delay_s * factor))
        samples = varied

    return samples


def synthesize_idle_mouse_drift(
    current: Point,
    *,
    anchor: Optional[Point] = None,
    screen: Tuple[int, int] = (1280, 800),
    radius_px: float = IDLE_MOUSE_RADIUS_PX,
    rng: Optional[random.Random] = None,
) -> MouseSample:
    """Create one low-amplitude idle cursor drift sample around an anchor point."""

    rng = rng or random.Random()
    anchor = anchor or current
    width, height = screen
    radius_px = max(0.5, min(12.0, radius_px))

    pull = rng.uniform(0.08, 0.22)
    next_x = current[0] + (anchor[0] - current[0]) * pull + rng.gauss(0, radius_px * 0.24)
    next_y = current[1] + (anchor[1] - current[1]) * pull + rng.gauss(0, radius_px * 0.24)

    dx = next_x - anchor[0]
    dy = next_y - anchor[1]
    distance = math.hypot(dx, dy)
    if distance > radius_px:
        scale = radius_px / distance
        next_x = anchor[0] + dx * scale
        next_y = anchor[1] + dy * scale

    bounded_x = int(round(max(0, min(width - 1, next_x))))
    bounded_y = int(round(max(0, min(height - 1, next_y))))
    if (bounded_x, bounded_y) == (int(round(current[0])), int(round(current[1]))):
        # Browser mousemove listeners only receive an event when the integer
        # client coordinate changes. Keep each idle step visible while staying
        # inside the small hand-tremor radius around the anchor.
        for _ in range(8):
            angle = rng.uniform(0, 2 * math.pi)
            step = rng.uniform(1.0, min(2.8, radius_px))
            candidate_x = int(round(max(0, min(width - 1, current[0] + math.cos(angle) * step))))
            candidate_y = int(round(max(0, min(height - 1, current[1] + math.sin(angle) * step))))
            if (candidate_x, candidate_y) != (bounded_x, bounded_y):
                cdx = candidate_x - anchor[0]
                cdy = candidate_y - anchor[1]
                if math.hypot(cdx, cdy) <= radius_px + 0.5:
                    bounded_x, bounded_y = candidate_x, candidate_y
                    break
    # Keep background pointer activity dense enough for long form-fill sessions.
    # FCaptcha computes mouseEventRate over the whole interaction window, so
    # sparse idle drift lets typing time dilute an otherwise human click path.
    delay_s = rng.uniform(0.018, 0.034)
    return MouseSample(bounded_x, bounded_y, delay_s)


class KeycapTimingSynthesizer:
    """Session-stable adapter around the vendored MIMIC keycap equations."""

    def __init__(
        self,
        *,
        rng: Optional[random.Random] = None,
        basis_count: int = 160,
        min_velocity: float = 7.0,
        max_velocity: float = 38.0,
    ) -> None:
        self._rng = rng or random.Random()
        self._basis_count = max(500, min(5000, basis_count))
        self._min_velocity = max(1.0, min_velocity)
        self._max_velocity = max(self._min_velocity, max_velocity)
        self._index = 0
        self._times: List[float] = []
        self._generate_times()

    def _generate_times(self) -> None:
        controller = Controller(n=self._basis_count, min_velocity=self._min_velocity, max_velocity=self._max_velocity)
        plant = Plant(controller)
        plant.default_design_controller()
        t = np.linspace(0, 1, 1000)
        velocities = plant.generate_model(t)
        times = plant.velocities_to_time(velocities)
        self._times = [float(value) for value in times if math.isfinite(float(value)) and float(value) > 0]
        self._rng.shuffle(self._times)
        self._index = 0

    def _next_interval(self) -> float:
        if not self._times or self._index >= len(self._times):
            self._generate_times()
        value = self._times[self._index]
        self._index += 1
        return value

    def next(self, char: str = "") -> KeyStrokeTiming:
        interval = self._next_interval()
        if char.isspace():
            interval += self._rng.uniform(0.04, 0.12)
        elif char in ".,;:!?":
            interval += self._rng.uniform(0.02, 0.08)

        dwell = max(0.035, min(0.14, interval * self._rng.uniform(0.35, 0.75)))
        if char and char.isupper():
            dwell += self._rng.uniform(0.005, 0.025)
        return KeyStrokeTiming(dwell_s=dwell, interval_s=interval)
