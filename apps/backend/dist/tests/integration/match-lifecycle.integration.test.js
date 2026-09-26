import axios from 'axios';
import * as StellarSdk from 'stellar-sdk';
import { describe, it, expect } from 'vitest';
const STELLAR_RPC_URL = process.env.STELLAR_RPC_URL;
const FRIENDBOT_URL = process.env.FRIENDBOT_URL;
const MASTER_SEED = process.env.STANDALONE_MASTER_SEED;
function getNativeBalance(account) {
    const bal = account.balances.find((b) => b.asset_type === 'native');
    return bal ? parseFloat(bal.balance) : 0;
}
async function fundAccount(pubKey, server) {
    if (FRIENDBOT_URL) {
        await axios.get(`${FRIENDBOT_URL}?addr=${encodeURIComponent(pubKey)}`);
        return;
    }
    if (MASTER_SEED) {
        const master = StellarSdk.Keypair.fromSecret(MASTER_SEED);
        const source = await server.loadAccount(master.publicKey());
        const tx = new StellarSdk.TransactionBuilder(source, {
            fee: (await server.fetchBaseFee()).toString(),
            networkPassphrase: StellarSdk.Networks.TESTNET,
        })
            .addOperation(StellarSdk.Operation.createAccount({ destination: pubKey, startingBalance: '1000' }))
            .setTimeout(30)
            .build();
        tx.sign(master);
        await server.submitTransaction(tx);
        return;
    }
    throw new Error('No funding method configured (set FRIENDBOT_URL or STANDALONE_MASTER_SEED)');
}
describe('integration: match lifecycle (standalone Stellar node)', () => {
    if (!STELLAR_RPC_URL) {
        it('skips because STELLAR_RPC_URL is not set', () => {
            expect(true).toBe(true);
        });
        return;
    }
    const server = new StellarSdk.Server(STELLAR_RPC_URL);
    it('creates accounts, deposits to escrow, finalizes and checks balances', async () => {
        // create three keypairs: playerA, playerB, escrow (escrow controlled by test)
        const playerA = StellarSdk.Keypair.random();
        const playerB = StellarSdk.Keypair.random();
        const escrow = StellarSdk.Keypair.random();
        // fund accounts
        await fundAccount(playerA.publicKey(), server);
        await fundAccount(playerB.publicKey(), server);
        await fundAccount(escrow.publicKey(), server);
        // check initial balances
        const aBefore = await server.loadAccount(playerA.publicKey());
        const bBefore = await server.loadAccount(playerB.publicKey());
        const escrowBefore = await server.loadAccount(escrow.publicKey());
        const aBalBefore = getNativeBalance(aBefore);
        const bBalBefore = getNativeBalance(bBefore);
        const escrowBalBefore = getNativeBalance(escrowBefore);
        // deposit: playerA sends 50 XLM to escrow
        const sourceA = await server.loadAccount(playerA.publicKey());
        const fee = await server.fetchBaseFee();
        const tx1 = new StellarSdk.TransactionBuilder(sourceA, {
            fee: fee.toString(),
            networkPassphrase: StellarSdk.Networks.TESTNET,
        })
            .addOperation(StellarSdk.Operation.payment({
            destination: escrow.publicKey(),
            asset: StellarSdk.Asset.native(),
            amount: '50',
        }))
            .setTimeout(30)
            .build();
        tx1.sign(playerA);
        await server.submitTransaction(tx1);
        const escrowAfterDeposit = await server.loadAccount(escrow.publicKey());
        const escrowBalAfterDeposit = getNativeBalance(escrowAfterDeposit);
        expect(escrowBalAfterDeposit).toBeGreaterThan(escrowBalBefore);
        // finalize: escrow sends 50 XLM to playerB (simulate oracle awarding playerB)
        const sourceEscrow = await server.loadAccount(escrow.publicKey());
        const tx2 = new StellarSdk.TransactionBuilder(sourceEscrow, {
            fee: (await server.fetchBaseFee()).toString(),
            networkPassphrase: StellarSdk.Networks.TESTNET,
        })
            .addOperation(StellarSdk.Operation.payment({
            destination: playerB.publicKey(),
            asset: StellarSdk.Asset.native(),
            amount: '50',
        }))
            .setTimeout(30)
            .build();
        tx2.sign(escrow);
        await server.submitTransaction(tx2);
        const aAfter = await server.loadAccount(playerA.publicKey());
        const bAfter = await server.loadAccount(playerB.publicKey());
        const escrowAfter = await server.loadAccount(escrow.publicKey());
        const aBalAfter = getNativeBalance(aAfter);
        const bBalAfter = getNativeBalance(bAfter);
        const escrowBalFinal = getNativeBalance(escrowAfter);
        // playerA should have decreased, playerB increased by ~50 (fees ignored for exact equality)
        expect(aBalAfter).toBeLessThanOrEqual(aBalBefore - 49);
        expect(bBalAfter).toBeGreaterThan(bBalBefore);
        expect(escrowBalFinal).toBeLessThan(escrowBalAfterDeposit + 1);
    }, 20000);
});
