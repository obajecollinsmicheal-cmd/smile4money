/**
 * MongoDB Persistent Queue Store
 *
 * Stores oracle job queue entries in MongoDB with automatic TTL cleanup.
 */
import mongoose from 'mongoose';
const dlqSchema = new mongoose.Schema({
    id: { type: String, required: true, unique: true, index: true },
    payload: { type: mongoose.Schema.Types.Mixed, required: true },
    failureReason: { type: String, required: true },
    attempts: { type: Number, required: true, default: 0 },
    createdAt: { type: Number, required: true },
    lastAttemptAt: { type: Number, required: false, default: null },
    // TTL index: auto-delete entries older than 30 days
    expireAt: {
        type: Date,
        default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        index: { expireAfterSeconds: 0 },
    },
}, { collection: 'oracle_dlq' });
const DlqModel = mongoose.model('OracleDLQ', dlqSchema);
export class MongoDBQueueStore {
    constructor() {
        this.connection = null;
    }
    async initialize() {
        if (mongoose.connection.readyState === 0) {
            const mongoUrl = process.env.MONGODB_URL || 'mongodb://localhost:27017/smile4money';
            await mongoose.connect(mongoUrl);
        }
        this.connection = mongoose.connection;
    }
    async add(entry) {
        await DlqModel.create({
            ...entry,
            expireAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        });
    }
    async getAll() {
        const docs = await DlqModel.find({}).exec();
        return docs.map((doc) => ({
            id: doc.id,
            payload: doc.payload,
            failureReason: doc.failureReason,
            attempts: doc.attempts,
            createdAt: doc.createdAt,
            lastAttemptAt: doc.lastAttemptAt,
        }));
    }
    async remove(id) {
        await DlqModel.deleteOne({ id });
    }
    async update(id, updates) {
        await DlqModel.updateOne({ id }, { $set: updates });
    }
    async count() {
        return await DlqModel.countDocuments({});
    }
    async clear() {
        await DlqModel.deleteMany({});
    }
    async close() {
        if (this.connection) {
            await mongoose.disconnect();
        }
    }
}
