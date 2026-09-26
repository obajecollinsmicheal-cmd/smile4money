import dotenv from 'dotenv';
dotenv.config();
import { app } from './app.js';
import { initializeQueue, closeQueue, startRetryWorker, listDlqEntries } from './queue.js';
import logger from './logger.js';
const port = Number(process.env.PORT || 4000);
/**
 * Oracle retry handler for reprocessing DLQ entries.
 * This is a placeholder that can be replaced with actual oracle submission logic.
 */
async function retryOracleSubmission(entry) {
    // Implementation depends on how the oracle submits results to the contract.
    // For now, this is a placeholder. In production, this would:
    // 1. Reconstruct the original submission request from entry.payload
    // 2. Call the Stellar RPC to submit the result
    // 3. Throw if submission fails
    logger.debug({ dlqId: entry.id }, 'Retrying oracle submission');
    // Placeholder: successful retry (would be replaced with actual logic)
}
async function main() {
    try {
        // Initialize the persistent queue store
        await initializeQueue();
        logger.info('Queue store initialized');
        // Load any pending jobs from the queue on startup
        const pendingEntries = await listDlqEntries();
        logger.info({ count: pendingEntries.length }, `Loaded ${pendingEntries.length} pending oracle submissions from queue`);
        // Start the retry worker
        const stopRetryWorker = startRetryWorker(retryOracleSubmission, 60000);
        // Start the Express server
        const server = app.listen(port, () => {
            logger.info({ port }, `smile4money-backend listening on http://localhost:${port}`);
        });
        // Graceful shutdown
        const shutdown = async () => {
            logger.info('Shutting down gracefully...');
            stopRetryWorker();
            await closeQueue();
            server.close(() => {
                logger.info('Server closed');
                process.exit(0);
            });
        };
        process.on('SIGTERM', shutdown);
        process.on('SIGINT', shutdown);
    }
    catch (error) {
        logger.error({ error }, 'Failed to start server');
        process.exit(1);
    }
}
main();
