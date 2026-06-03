export type WalletStatus = 'checking' | 'notInstalled' | 'disconnected' | 'connecting' | 'connected' | 'wrongNetwork' | 'error';

export type Mode = 'claim' | 'burn';

export type Network = 'testnet' | 'mainnet' | 'unknown';

export interface WalletState {
  status: WalletStatus;
  address: string | null;
  error: string | null;
  balance: string | null;
  network: Network;
}
