import { Router } from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { getCircuitBreaker, type CircuitState } from '../services/circuit-breaker.js';
import { listDlqEntries, replayDlqEntry } from '../queue.js';
import { buildStatus, loadIncidents } from '../services/status-service.js';
import { getQueueMetrics, type QueueMetrics } from '../services/queue-metrics.js';
import { logger } from '../logger.js';

/**
 * GET /status: public, component-level service status and incidents (#115).
 * Unauthenticated and cacheable for 30 s. Never fails: a signal that can't
 * be read is reported as `unknown`. See docs/status-page.md.
 */
const router = Router();

const defaultIncidentsFile = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../data/status-incidents.json',
);

router.get('/', async (_req, res) => {
  let rpcCircuit: CircuitState | null = null;
  try {
    rpcCircuit = getCircuitBreaker().getState();
  } catch {
    rpcCircuit = null;
  }
  let pendingSubmissions: number | null = null;
  try {
    pendingSubmissions = (await listDlqEntries()).length;
  } catch {
    pendingSubmissions = null;
  }
  let queueMetrics: QueueMetrics | null = null;
  try {
    queueMetrics = await getQueueMetrics();
  } catch {
    queueMetrics = null;
  }
  const status = buildStatus({
    rpcCircuit,
    pendingSubmissions,
    queueMetrics,
    incidents: loadIncidents(process.env.STATUS_INCIDENTS_FILE || defaultIncidentsFile),
    now: new Date(),
  });
  res.set('Cache-Control', 'public, max-age=30');
  res.status(200).json(status);
});

/**
 * POST /status/queue/:id/replay: manually replay a failed queue entry (#2184).
 * Validates the entry ID, reprocesses the entry as if new, and returns the
 * replay result. 404 for unknown IDs, 409 for entries that are not failed.
 */
router.post('/queue/:id/replay', async (req, res) => {
  const id = req.params.id;
  if (!id || typeof id !== 'string' || id.trim() === '') {
    res.status(400).json({ error: 'invalid_entry_id' });
    return;
  }

  try {
    const result = await replayDlqEntry(id);
    if (result === null) {
      logger.warn({ entryId: id }, 'queue replay requested for unknown entry');
      res.status(404).json({ error: 'entry_not_found', entryId: id });
      return;
    }
    if (result.replayResult === 'not_failed') {
      logger.warn({ entryId: id }, 'queue replay requested for non-failed entry');
      res.status(409).json({ error: 'entry_not_failed', entryId: id });
      return;
    }
    logger.info(
      { entryId: id, replayResult: result.replayResult, replayedAt: result.replayedAt },
      'queue entry replayed',
    );
    res.status(200).json({
      entryId: id,
      replayResult: result.replayResult,
      replayedAt: result.replayedAt,
    });
  } catch (err) {
    logger.error({ err, entryId: id }, 'queue replay failed');
    res.status(500).json({ error: 'replay_failed', entryId: id });
  }
});

export default router;