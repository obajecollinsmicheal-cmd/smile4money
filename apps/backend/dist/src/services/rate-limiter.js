export class RateLimiter {
    constructor(capacity, refillIntervalMs, refillAmount) {
        this.capacity = capacity;
        this.refillIntervalMs = refillIntervalMs;
        this.refillAmount = refillAmount;
        this.queue = [];
        this.tokens = capacity;
        this.lastRefill = Date.now();
        setInterval(() => this.refill(), this.refillIntervalMs);
    }
    refill() {
        const now = Date.now();
        if (now - this.lastRefill < this.refillIntervalMs) {
            return;
        }
        this.lastRefill = now;
        this.tokens = Math.min(this.capacity, this.tokens + this.refillAmount);
        while (this.tokens > 0 && this.queue.length > 0) {
            this.tokens -= 1;
            const next = this.queue.shift();
            if (next) {
                next();
            }
        }
    }
    async schedule(work) {
        return new Promise((resolve, reject) => {
            const runner = async () => {
                try {
                    const result = await work();
                    resolve(result);
                }
                catch (error) {
                    reject(error);
                }
            };
            if (this.tokens > 0) {
                this.tokens -= 1;
                runner();
                return;
            }
            console.info('Lichess request queued due to rate limiting');
            this.queue.push(runner);
        });
    }
    getQueueLength() {
        return this.queue.length;
    }
    getRemainingTokens() {
        return this.tokens;
    }
}
