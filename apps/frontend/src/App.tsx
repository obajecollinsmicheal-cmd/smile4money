import { ClaimBurn } from './components/claim-burn';
import { useStellarWallet } from './hooks/useStellarWallet';

export function App() {
  const { status, address, balance, network, connect, disconnect, refreshBalance } = useStellarWallet();

  const walletState = (
    status === 'connected' && network !== 'unknown' && network !== 'testnet'
      ? 'wrongNetwork'
      : status
  ) as WalletStatus;

  const handleClaim = async (amount: string): Promise<string | void> => {
    // TODO: submit claim transaction via Stellar SDK
    console.info('Claim request', amount);
  };

  const handleBurn = async (amount: string): Promise<string | void> => {
    // TODO: submit burn transaction via Stellar SDK
    console.info('Burn request', amount);
  };

  return (
    <main style={{ padding: '2rem', minHeight: '100vh', background: '#f5f5f5' }}>
      <ClaimBurn
        walletState={walletState}
        onConnect={connect}
        onDisconnect={disconnect}
        onRefreshBalance={refreshBalance}
        onClaim={handleClaim}
        onBurn={handleBurn}
        onDisconnect={disconnect}
        onRefreshBalance={refreshBalance}
        publicKey={address}
        balance={balance}
        expectedNetwork="testnet"
      />
    </main>
  );
}
