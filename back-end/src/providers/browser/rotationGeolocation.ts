import type { ProxyGeoLocation } from '../geoip';

// A rotation exists to land on a different egress IP. Both managed pools are
// keyed by geolocation and kept handing the same exit node back for the same
// pinned location across separate sessions: Steel for the same state (live
// parity saw one IP three runs in a row) and Kernel for the same city (the
// cached `residential:US:<state>:<city>` proxy answered 187.14.91.118 before and
// after a residential rotation, 2026-10-07). So a rotation moves to another
// large US state and drops the city. Outside the US both providers only key on
// country; the rotation can only drop the city there. A Tilion step that
// recreates the session (mobile) uses the same rule; Tilion's in-place
// `rotate-ip` keeps the session's placement and only changes the exit.
//
// The task picks where its walk through the list starts and the task's own
// rotation count is the step, so the rotations of one task never repeat a state
// (the list is longer than the rotation cap). Hashing the session being replaced
// instead let two consecutive rotations draw the same state: rotations 3 and 4
// both asked Steel for FL and read one exit IP.
export const ROTATION_STATES = ['TX', 'CA', 'FL', 'NY', 'IL', 'GA', 'WA', 'AZ', 'PA', 'OH'];

export function rotationGeolocation(
  geolocation: ProxyGeoLocation,
  taskId: string,
  rotation: number
): ProxyGeoLocation {
  const withoutCity: ProxyGeoLocation = {
    country: geolocation.country,
    ...(geolocation.state ? { state: geolocation.state } : {}),
  };
  if (geolocation.country !== 'US') return withoutCity;
  const current = (geolocation.state ?? '').toUpperCase();
  const candidates = ROTATION_STATES.filter((state) => state !== current);
  let hash = 0;
  for (const char of taskId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return { ...withoutCity, state: candidates[(hash + rotation) % candidates.length] };
}
