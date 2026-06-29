/**
 * Deprecated compatibility module for imports that still reference the old
 * split network grep service. /api/data/grep now routes through service.grep.
 */

export { grep as grepNetwork, InvalidPatternError as InvalidNetworkPatternError } from './service';
