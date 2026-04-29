import type { Metadata } from 'next'
import { IBM_Plex_Serif, IBM_Plex_Sans, IBM_Plex_Mono } from 'next/font/google'
import './globals.css'
import Header from '@/components/Header'
import Footer from '@/components/Footer'

const ibmPlexSerif = IBM_Plex_Serif({
  subsets: ['latin'],
  weight: ['400', '600', '700'],
  style: ['normal', 'italic'],
  variable: '--font-ibm-plex-serif',
  display: 'swap',
})

const ibmPlexSans = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600'],
  variable: '--font-ibm-plex-sans',
  display: 'swap',
})

const ibmPlexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-ibm-plex-mono',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Britannia Metals Desk',
  description: 'LME base metals dashboard — Britannia Global Markets',
  robots: 'noindex, nofollow',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html
      lang="en"
      className={`${ibmPlexSerif.variable} ${ibmPlexSans.variable} ${ibmPlexMono.variable}`}
    >
      <body className="font-sans bg-[#FAF8F4] text-[#1A1A1A] min-h-screen flex flex-col">
        <Header />
        <main className="flex-1 w-full max-w-[1440px] mx-auto px-6 py-6">
          {children}
        </main>
        <Footer />
      </body>
    </html>
  )
}
