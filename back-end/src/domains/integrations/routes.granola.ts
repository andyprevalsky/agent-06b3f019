/** Granola routes use the shared meeting integration route contract. */
import { createMeetingRoutes } from './routes.meetings';
import {
  startGranolaSignIn,
  completeGranolaSignIn,
  disconnectGranola,
  getGranolaStatus,
  syncGranolaUser,
  runGranolaSyncJob,
} from '../../services/integrations/granolaSync';
export const GRANOLA_CALLBACK_PATH = '/integrations/granola/callback';
export default createMeetingRoutes('granola', 'Granola', {
  startSignIn: startGranolaSignIn,
  completeSignIn: completeGranolaSignIn,
  disconnect: disconnectGranola,
  getStatus: getGranolaStatus,
  syncUser: syncGranolaUser,
  runSyncJob: runGranolaSyncJob,
});
