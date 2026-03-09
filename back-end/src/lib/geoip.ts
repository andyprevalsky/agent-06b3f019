import { Request } from 'express';

export interface ProxyGeoLocation {
  country: string;  // 2-letter country code (e.g., "US")
  state?: string;   // 2-letter state abbreviation (e.g., "TX") - only valid for US
  city?: string;    // City name uppercase (e.g., "DALLAS")
}

// US state name to abbreviation mapping
const US_STATE_ABBREVS: Record<string, string> = {
  'Alabama': 'AL', 'Alaska': 'AK', 'Arizona': 'AZ', 'Arkansas': 'AR', 'California': 'CA',
  'Colorado': 'CO', 'Connecticut': 'CT', 'Delaware': 'DE', 'Florida': 'FL', 'Georgia': 'GA',
  'Hawaii': 'HI', 'Idaho': 'ID', 'Illinois': 'IL', 'Indiana': 'IN', 'Iowa': 'IA',
  'Kansas': 'KS', 'Kentucky': 'KY', 'Louisiana': 'LA', 'Maine': 'ME', 'Maryland': 'MD',
  'Massachusetts': 'MA', 'Michigan': 'MI', 'Minnesota': 'MN', 'Mississippi': 'MS', 'Missouri': 'MO',
  'Montana': 'MT', 'Nebraska': 'NE', 'Nevada': 'NV', 'New Hampshire': 'NH', 'New Jersey': 'NJ',
  'New Mexico': 'NM', 'New York': 'NY', 'North Carolina': 'NC', 'North Dakota': 'ND', 'Ohio': 'OH',
  'Oklahoma': 'OK', 'Oregon': 'OR', 'Pennsylvania': 'PA', 'Rhode Island': 'RI', 'South Carolina': 'SC',
  'South Dakota': 'SD', 'Tennessee': 'TN', 'Texas': 'TX', 'Utah': 'UT', 'Vermont': 'VT',
  'Virginia': 'VA', 'Washington': 'WA', 'West Virginia': 'WV', 'Wisconsin': 'WI', 'Wyoming': 'WY',
  'District of Columbia': 'DC',
};

/**
 * Extract client IP address from request.
 * Handles x-forwarded-for header for requests behind proxies/load balancers.
 */
export function getClientIP(req: Request): string | null {
  // x-forwarded-for header is set by proxies/load balancers (e.g., Render, Vercel)
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // Can be comma-separated list, first one is the original client
    const ip = Array.isArray(forwarded) ? forwarded[0] : forwarded.split(',')[0].trim();
    // Skip localhost/private IPs
    if (ip && !isPrivateIP(ip)) {
      return ip;
    }
  }

  // Fallback to req.ip (Express's client IP)
  const ip = req.ip;
  if (ip && !isPrivateIP(ip)) {
    return ip;
  }

  return null;
}

/**
 * Check if an IP is private/localhost (not useful for geolocation)
 */
function isPrivateIP(ip: string): boolean {
  // Remove IPv6 prefix if present
  const cleanIP = ip.replace('::ffff:', '');

  return (
    cleanIP === '127.0.0.1' ||
    cleanIP === 'localhost' ||
    cleanIP === '::1' ||
    cleanIP.startsWith('10.') ||
    cleanIP.startsWith('172.16.') ||
    cleanIP.startsWith('172.17.') ||
    cleanIP.startsWith('172.18.') ||
    cleanIP.startsWith('172.19.') ||
    cleanIP.startsWith('172.20.') ||
    cleanIP.startsWith('172.21.') ||
    cleanIP.startsWith('172.22.') ||
    cleanIP.startsWith('172.23.') ||
    cleanIP.startsWith('172.24.') ||
    cleanIP.startsWith('172.25.') ||
    cleanIP.startsWith('172.26.') ||
    cleanIP.startsWith('172.27.') ||
    cleanIP.startsWith('172.28.') ||
    cleanIP.startsWith('172.29.') ||
    cleanIP.startsWith('172.30.') ||
    cleanIP.startsWith('172.31.') ||
    cleanIP.startsWith('192.168.')
  );
}

/**
 * Look up geolocation from IP address using ip-api.com.
 * Free tier: 45 requests/minute, no API key needed.
 * Returns null if lookup fails or IP is not geolocatable.
 */
export async function getGeoFromIP(ip: string): Promise<ProxyGeoLocation | null> {
  try {
    // ip-api.com free API (HTTP only for free tier)
    const response = await fetch(
      `http://ip-api.com/json/${ip}?fields=status,countryCode,regionName,city`,
      { signal: AbortSignal.timeout(3000) }  // 3 second timeout
    );

    if (!response.ok) {
      console.warn(`[GeoIP] Failed to fetch geolocation for ${ip}: ${response.status}`);
      return null;
    }

    const data = await response.json() as {
      status: string;
      countryCode?: string;
      regionName?: string;
      city?: string;
    };

    if (data.status !== 'success') {
      console.warn(`[GeoIP] Geolocation lookup failed for ${ip}: ${data.status}`);
      return null;
    }

    const country = data.countryCode || 'US';
    const regionName = data.regionName || '';
    const city = data.city || '';

    // Convert state name to abbreviation (for US)
    let state = regionName;
    if (country === 'US' && US_STATE_ABBREVS[regionName]) {
      state = US_STATE_ABBREVS[regionName];
    }

    const result: ProxyGeoLocation = {
      country,
      ...(state && { state: state.toUpperCase().substring(0, 2) }),
      ...(city && { city: city.toUpperCase() }),
    };

    console.log(`[GeoIP] Resolved ${ip} -> ${result.city}, ${result.state}, ${result.country}`);
    return result;

  } catch (error) {
    console.warn(`[GeoIP] Error looking up geolocation for ${ip}:`, error);
    return null;
  }
}

/**
 * Default geolocation to use when IP lookup fails or is unavailable.
 */
export const DEFAULT_GEOLOCATION: ProxyGeoLocation = {
  country: 'US',
  state: 'TX',
  city: 'DALLAS',
};
