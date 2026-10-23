/**
 * Blackbox-only SMS supervisor routes, mounted by server.ts when
 * BLACKBOX_TEST_CAPTURE_OUTBOUND=1.
 */

import express from 'express';
import { clearSupervisorFixtureOverride, setSupervisorFixtureOverride } from './supervisorFixtures';
import {
  runProactiveSmsOutreachJob,
  runProactiveSmsOutreachJobWithLease,
} from './proactiveOutreach';

// Per-user SMS supervisor LLM-response fixture. Lets blackbox tests swap the
// fixture between cases without rebooting the backend. POST { userId,
// fixture } registers; DELETE ?userId clears.
export function createSupervisorFixtureTestRouter(): express.Router {
  const fixtureRouter = express.Router();
  fixtureRouter.post('/', express.json(), (req, res) => {
    const { userId, fixture } = req.body as { userId?: unknown; fixture?: unknown };
    if (typeof userId !== 'string' || typeof fixture !== 'string') {
      res.status(400).json({ error: 'userId and fixture must be strings' });
      return;
    }
    setSupervisorFixtureOverride(userId, fixture);
    res.json({ ok: true });
  });
  fixtureRouter.delete('/', (req, res) => {
    const userId = req.query.userId;
    if (typeof userId !== 'string') {
      res.status(400).json({ error: 'userId query param required' });
      return;
    }
    clearSupervisorFixtureOverride(userId);
    res.json({ ok: true });
  });
  return fixtureRouter;
}

export function createProactiveSmsTestRouter(): express.Router {
  const proactiveSmsRouter = express.Router();
  const parseProactiveSmsJobOptions = (body: unknown) => {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return null;
    }
    const { now: nowValue, userIds: userIdsValue } = body as {
      now?: unknown;
      userIds?: unknown;
    };
    const now =
      nowValue === undefined
        ? new Date()
        : typeof nowValue === 'string'
          ? new Date(nowValue)
          : null;
    const userIds =
      userIdsValue === undefined
        ? undefined
        : Array.isArray(userIdsValue) &&
            userIdsValue.every((value): value is string => typeof value === 'string')
          ? userIdsValue
          : null;
    return now === null || Number.isNaN(now.getTime()) || userIds === null
      ? null
      : { now, candidateUserIds: userIds };
  };
  const rejectInvalidProactiveSmsOptions = (res: express.Response): void => {
    res.status(400).json({ error: 'now must be an ISO date and userIds must be a string array' });
  };
  proactiveSmsRouter.post('/run', (req, res, next) => {
    const options = parseProactiveSmsJobOptions(req.body);
    if (options === null) {
      rejectInvalidProactiveSmsOptions(res);
      return;
    }
    runProactiveSmsOutreachJob(options)
      .then((summary) => res.json(summary))
      .catch(next);
  });
  proactiveSmsRouter.post('/run-leased', (req, res, next) => {
    const options = parseProactiveSmsJobOptions(req.body);
    if (options === null) {
      rejectInvalidProactiveSmsOptions(res);
      return;
    }
    runProactiveSmsOutreachJobWithLease(options)
      .then((result) => res.json(result))
      .catch(next);
  });
  return proactiveSmsRouter;
}
