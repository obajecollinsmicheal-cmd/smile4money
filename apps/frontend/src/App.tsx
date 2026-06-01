import { ClaimBurn } from './components/claim-burn';
import { useStellarWallet } from './hooks/useStellarWallet';
import type { WalletStatus } from './types';

export function App() {
  const {
    status,
    address,
    balance,
    network,
    connect,
    disconnect,
    refreshBalance,
  } = useStellarWallet();

  // Derive walletState: map 'connected' on wrong network to 'wrongNetwork'
  const walletState: WalletStatus =
    status === 'connected' && network !== 'unknown' && network !== 'testnet'
      ? 'wrongNetwork'
      : (status as WalletStatus);

  const handleClaim = async (amount: string): Promise<string | void> => {
    // TODO: integrate with Stellar smart contract claim transaction
    console.info('Claim request', amount);
  };

  const handleBurn = async (amount: string): Promise<string | void> => {
    // TODO: integrate with Stellar smart contract burn transaction
    console.info('Burn request', amount);
  };

  const handleSwitchNetwork = () => {
    // Freighter does not support programmatic network switching;
    // disconnect so the user can reconfigure and reconnect.
    disconnect();
  };

  return (
    <main style={{ padding: '2rem', minHeight: '100vh', background: '#f5f5f5' }}>
      <ClaimBurn
        walletState={walletState}
        onConnect={connect}
        onDisconnect={disconnect}
        onClaim={handleClaim}
        onBurn={handleBurn}
        onSwitchNetwork={handleSwitchNetwork}
        onRefreshBalance={refreshBalance}
        publicKey={address}
        balance={balance}
        expectedNetwork="testnet"
      />
    </main>
  );
}
