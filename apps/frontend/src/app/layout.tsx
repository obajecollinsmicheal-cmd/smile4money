import './globals.css'

export const metadata = {
  title: 'smile4money',
  description: 'Competitive Chess Betting on Stellar',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-white min-h-screen">{children}</body>
    </html>
  )
}
