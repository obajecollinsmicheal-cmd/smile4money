import { useState, useCallback, useEffect } from 'react';
import type { WalletStatus, Network } from '../types';

const EXPECTED_NETWORK = (typeof import.meta !== 'undefined' && (import.meta as { env?: { VITE_STELLAR_NETWORK?: string } }).env?.VITE_STELLAR_NETWORK) || 'testnet';

declare global {
  interface Window {
    freighterApi?: {
      isConnected: () => Promise<{ isConnected: boolean }>;
      getPublicKey: () => Promise<string>;
      signTransaction: (
        xdr: string,
        opts?: { networkPassphrase?: string },
      ) => Promise<{ signedTxXdr: string }>;
      getNetwork?: () => Promise<{ network: string; networkPassphrase: string }>;
    };
  }
}

const HORIZON_URLS: Record<string, string> = {
  testnet: 'https://horizon-testnet.stellar.org',
  mainnet: 'https://horizon.stellar.org',
  unknown: 'https://horizon-testnet.stellar.org',
};

interface StellarWallet {
  status: WalletStatus;
  address: string | null;
  error: string | null;
  balance: string | null;
  network: Network;
  isInstalled: boolean;
  connect: () => Promise<void>;
  disconnect: () => void;
  refreshBalance: () => Promise<void>;
}

function detectNetwork(networkPassphrase?: string): Network {
  if (!networkPassphrase) return 'unknown';
  if (networkPassphrase.includes('testnet')) return 'testnet';
  if (networkPassphrase.includes('pubnet')) return 'mainnet';
  return 'unknown';
}

async function fetchHorizonBalance(
  address: string,
  network: Network,
): Promise<string> {
  const horizon = HORIZON_URLS[network] || HORIZON_URLS.unknown;
  const res = await fetch(`${horizon}/accounts/${address}`);
  if (!res.ok) throw new Error('Failed to fetch balance');
  const data = await res.json();
  const native = data.balances.find(
    (b: { asset_type: string }) => b.asset_type === 'native',
  );
  return native ? native.balance : '0';
}

export function useStellarWallet(): StellarWallet {
  const [status, setStatus] = useState<WalletStatus>('checking');
  const [address, setAddress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [network, setNetwork] = useState<Network>('unknown');

  const freighter =
    typeof window !== 'undefined' ? window.freighterApi : undefined;
  const isInstalled = !!freighter;

  useEffect(() => {
    if (typeof window === 'undefined') {
      setStatus('disconnected');
      return;
    }
    setStatus(window.freighterApi ? 'disconnected' : 'notInstalled');
  }, []);

  const refreshBalance = useCallback(async () => {
    if (!address) return;
    try {
      const bal = await fetchHorizonBalance(address, network);
      setBalance(bal);
    } catch {
      setBalance(null);
    }
  }, [address, network]);

  const connect = useCallback(async () => {
    if (!freighter) {
      setStatus('notInstalled');
      return;
    }

    setStatus('connecting');
    setError(null);

    try {
      const { isConnected } = await freighter.isConnected();
      if (!isConnected) {
        setStatus('disconnected');
        return;
      }

      const publicKey = await freighter.getPublicKey();
      setAddress(publicKey);

      let detectedNetwork: Network = 'unknown';
      if (freighter.getNetwork) {
        const net = await freighter.getNetwork();
        detectedNetwork = detectNetwork(net.networkPassphrase);
        setNetwork(detectedNetwork);
      }

      if (detectedNetwork !== 'unknown' && detectedNetwork !== EXPECTED_NETWORK) {
        setStatus('wrongNetwork');
      } else {
        setStatus('connected');
      }

      fetchHorizonBalance(publicKey, detectedNetwork)
        .then((bal) => setBalance(bal))
        .catch(() => setBalance(null));
    } catch (err) {
      setStatus('error');
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to connect to Freighter wallet',
      );
    }
  }, [freighter]);

  const disconnect = useCallback(() => {
    setAddress(null);
    setBalance(null);
    setStatus(freighter ? 'disconnected' : 'notInstalled');
    setError(null);
    setNetwork('unknown');
  }, [freighter]);

  return {
    status,
    address,
    error,
    balance,
    network,
    isInstalled,
    connect,
    disconnect,
    refreshBalance,
  };
}
