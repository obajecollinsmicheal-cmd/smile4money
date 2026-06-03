import { ClaimBurn } from '@/components/claim-burn'

export default function ClaimBurnPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <ClaimBurn walletState="connected" tokenSymbol="XLM" balance="250.00" />
    </main>
  )
}
