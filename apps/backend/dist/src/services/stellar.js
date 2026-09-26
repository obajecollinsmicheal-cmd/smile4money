import axios from 'axios';
export async function checkStellarRpc() {
    const rpcUrl = process.env.STELLAR_RPC_URL;
    if (!rpcUrl) {
        throw new Error('STELLAR_RPC_URL not configured');
    }
    const response = await axios.post(rpcUrl, {
        method: 'get health',
        params: [],
        id: 1,
        jsonrpc: '2.0',
    }, {
        timeout: 5000,
        headers: {
            'Content-Type': 'application/json',
        },
    });
    if (response.status !== 200 || !response.data || response.data.error) {
        throw new Error('Stellar RPC unavailable');
    }
}
