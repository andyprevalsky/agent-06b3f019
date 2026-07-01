/**
 * Deprecated compatibility module for imports that still reference the old
 * split agent-network grep service. /api/data/grep now routes through service.grep.
 */

export {
  grep as grepAgentNetwork,
  MissingAgentIdError,
  AgentNotFoundError,
  InvalidPatternError,
} from './service';
