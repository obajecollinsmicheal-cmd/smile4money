import dotenv from 'dotenv';
import { beforeEach } from 'vitest';

dotenv.config({ path: '../../.env.example' });

// Use fake timers for all tests to prevent infinite timer loops
beforeEach(() => {
  // Vitest uses fake timers by default in the test environment
  // This is configured in vitest.config.ts
});
