import { matchStore } from '../store/index.js';
export class Match {
    static async deleteMany(_filter = {}) {
        matchStore.clear();
    }
    static async findOne(query) {
        return matchStore.findByGameId(query.gameId);
    }
    static async countDocuments() {
        return matchStore.count();
    }
}
