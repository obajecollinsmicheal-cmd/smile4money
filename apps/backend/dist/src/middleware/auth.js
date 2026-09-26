import jwt, { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';
/**
 * JWT_SECRET is used to sign and verify authentication tokens.
 * REQUIRED: Must be a strong, random string set in the environment.
 * If not set, defaults to 'test-secret' for development only.
 * NEVER use default in production.
 */
const SECRET = process.env.JWT_SECRET || 'test-secret';
// Check if we're in production without a proper secret
if (process.env.NODE_ENV === 'production' && SECRET === 'test-secret') {
    console.warn('WARNING: JWT_SECRET is not set in production. This is a security vulnerability. ' +
        'Set JWT_SECRET to a strong random string in your environment variables.');
}
/**
 * Authentication middleware that verifies JWT tokens in the Authorization header.
 * Extracts the Stellar address from the JWT payload and attaches it to req.address.
 *
 * Expected header format: "Authorization: Bearer <jwt-token>"
 * JWT payload must contain: { address: "<stellar-address>" }
 *
 * Returns:
 * - 401 if no Authorization header is provided
 * - 401 if token is malformed or invalid
 * - 401 if token has expired
 * - 401 if token doesn't contain a valid address claim
 */
export function authenticate(req, res, next) {
    const auth = req.header('Authorization');
    if (!auth || !auth.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid Authorization header' });
    }
    const token = auth.slice(7);
    try {
        const payload = jwt.verify(token, SECRET);
        if (!payload || typeof payload.address !== 'string') {
            return res.status(401).json({ error: 'unauthorized', message: 'Invalid token payload' });
        }
        req.address = payload.address;
        next();
    }
    catch (error) {
        if (error instanceof TokenExpiredError) {
            return res.status(401).json({ error: 'unauthorized', message: 'Token has expired' });
        }
        if (error instanceof JsonWebTokenError) {
            return res.status(401).json({ error: 'unauthorized', message: 'Invalid token' });
        }
        return res.status(401).json({ error: 'unauthorized', message: 'Authentication failed' });
    }
}
