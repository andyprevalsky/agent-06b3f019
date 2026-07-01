import { getGeoFromIP, geoFromDeliveryAddress, DEFAULT_GEOLOCATION } from '../../providers/geoip';
import { dollarsToMicrodollars, getModelPricing } from '../../providers/modelPricing';
import * as repo from './repo';

/** Fetch model pricing and resolve geolocation. Sub-agents inherit their
 *  parent's stored proxy fields rather than geolocating the worker IP, which
 *  would otherwise stamp every sub-agent with the Fly.io worker's location.
 *
 *  Root agents prefer the client IP. When the "client" is a server (no IP, e.g.
 *  SMS/scheduled runs) or the IP can't be resolved, fall back to the user's
 *  delivery address city/state so the proxy follows where the user lives; only
 *  if there's no usable address do we use DEFAULT_GEOLOCATION.
 *
 *  Exported so agentBatchService can reuse the exact same path. */
export async function resolveCreateMetadata(
  model: string,
  clientIP: string | null,
  parentAgentId: string | null,
  userId: string
) {
  const pricing = await getModelPricing(model);
  let tokenInPriceMicrodollars: number | null = null;
  let tokenOutPriceMicrodollars: number | null = null;

  if (pricing !== null && pricing !== undefined) {
    tokenInPriceMicrodollars = dollarsToMicrodollars(pricing.prompt);
    tokenOutPriceMicrodollars = dollarsToMicrodollars(pricing.completion);
  }

  let proxyGeo = DEFAULT_GEOLOCATION;
  if (parentAgentId !== null) {
    const parentProxy = await repo.findAgentProxy(parentAgentId);
    if (parentProxy !== null && parentProxy !== undefined && parentProxy.proxyCountry !== null) {
      proxyGeo = {
        country: parentProxy.proxyCountry,
        ...(parentProxy.proxyState !== null ? { state: parentProxy.proxyState } : {}),
        ...(parentProxy.proxyCity !== null ? { city: parentProxy.proxyCity } : {}),
      };
    }
  } else {
    let geo = clientIP !== null ? await getGeoFromIP(clientIP) : null;
    if (geo === null || geo === undefined) {
      const address = await repo.findUserDeliveryAddress(userId);
      if (address !== null && address !== undefined) {
        geo = geoFromDeliveryAddress(address);
      }
    }
    if (geo !== null && geo !== undefined) {
      proxyGeo = geo;
    }
  }

  return { tokenInPriceMicrodollars, tokenOutPriceMicrodollars, proxyGeo };
}
