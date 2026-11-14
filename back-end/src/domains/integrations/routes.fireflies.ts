/** Fireflies routes use the shared meeting integration route contract. */
import { createMeetingRoutes } from './routes.meetings';
import {
  startFirefliesSignIn,
  completeFirefliesSignIn,
  disconnectFireflies,
  getFirefliesStatus,
  syncFirefliesUser,
  runFirefliesSyncJob,
} from '../../services/integrations/firefliesSync';
export const FIREFLIES_CALLBACK_PATH = '/integrations/fireflies/callback';
export default createMeetingRoutes('fireflies', 'Fireflies', {
  startSignIn: startFirefliesSignIn,
  completeSignIn: completeFirefliesSignIn,
  disconnect: disconnectFireflies,
  getStatus: getFirefliesStatus,
  syncUser: syncFirefliesUser,
  runSyncJob: runFirefliesSyncJob,
});
