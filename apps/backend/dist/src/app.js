import express from 'express';
import cors from 'cors';
import healthRouter from './routes/health.js';
import matchRouter from './routes/matches.js';
import validateGameRouter from './routes/validate-game.js';
import oracleRouter from './routes/oracle.js';
/**
 * Parse the ALLOWED_ORIGINS environment variable into an array of origin strings.
 * Accepts a comma-separated list, e.g. "https://app.example.com,https://staging.example.com".
 * Falls back to the frontend URL in production or localhost in development.
 */
function getAllowedOrigins() {
    if (process.env.ALLOWED_ORIGINS) {
        return process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean);
    }
    if (process.env.FRONTEND_URL) {
        return [process.env.FRONTEND_URL];
    }
    // Development fallback — not used when ALLOWED_ORIGINS is set in production
    return ['http://localhost:5173'];
}
export const app = express();
app.use(cors({
    origin: (origin, callback) => {
        const allowed = getAllowedOrigins();
        // Allow server-to-server requests (no Origin header) and listed origins
        if (!origin || allowed.includes(origin)) {
            callback(null, true);
        }
        else {
            callback(new Error(`CORS: origin '${origin}' is not allowed`));
        }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: true,
}));
app.use(express.json());
app.use('/health', healthRouter);
app.use('/api/matches', matchRouter);
app.use('/api/validate-game', validateGameRouter);
app.use('/api/oracle', oracleRouter);
export default app;
