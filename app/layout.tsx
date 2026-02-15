import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'ProductGPT - AI-Powered Product Explainer',
  description: 'Ask product questions and get AI-powered explanations',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" className="dark">
      <body>{children}</body>
    </html>
  )
}
