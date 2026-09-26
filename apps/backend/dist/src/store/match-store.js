export class MatchStore {
    constructor() {
        this.matches = new Map();
        this.gameIds = new Set();
        this.nextId = 0;
    }
    async createMatch(payload) {
        if (this.gameIds.has(payload.gameId)) {
            throw new Error('duplicate game_id');
        }
        const record = {
            matchId: this.nextId,
            player1: payload.player1,
            player2: payload.player2,
            player1Username: payload.player1Username,
            player2Username: payload.player2Username,
            stakeAmount: payload.stakeAmount,
            token: payload.token,
            gameId: payload.gameId,
            platform: payload.platform,
            state: 'Pending',
        };
        this.matches.set(this.nextId, record);
        this.gameIds.add(payload.gameId);
        this.nextId += 1;
        return record;
    }
    async findByGameId(gameId) {
        for (const match of this.matches.values()) {
            if (match.gameId === gameId) {
                return match;
            }
        }
        return null;
    }
    async count() {
        return this.matches.size;
    }
    clear() {
        this.matches.clear();
        this.gameIds.clear();
        this.nextId = 0;
    }
}
