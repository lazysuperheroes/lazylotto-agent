import './styles/globals.css';
import type { Metadata } from 'next';
import { Heebo, Unbounded, Press_Start_2P } from 'next/font/google';
import { Sidebar } from './components/Sidebar';
import { ToastProvider } from './components/Toast';

// ---------------------------------------------------------------------------
// Fonts — loaded via next/font (no CSS @import needed)
// ---------------------------------------------------------------------------
//
// - Heebo: body (refined sans for all reading)
// - Unbounded: headings + display (confident, on-brand)
// - Press Start 2P: contextual comic-book labels and callouts
//   (ISSUE #001 stickers, small-caps tags, SFX text). Used sparingly —
//   the brand brief calls for it as a "contextual character/game" font,
//   not a body choice.

const heebo = Heebo({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-heebo',
  display: 'swap',
});

const unbounded = Unbounded({
  subsets: ['latin'],
  weight: ['400', '600', '700', '800'],
  variable: '--font-unbounded',
  display: 'swap',
});

const pressStart = Press_Start_2P({
  subsets: ['latin'],
  weight: ['400'],
  variable: '--font-pixel',
  display: 'swap',
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

export const metadata: Metadata = {
  title: {
    default: 'LazyLotto Agent',
    template: '%s | LazyLotto Agent',
  },
  description:
    'Autonomous lottery agent on Hedera. Authenticate to play, manage funds, and track prizes.',
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL || 'https://testnet-agent.lazysuperheroes.com',
  ),
  icons: {
    icon: '/favicon.svg',
  },
  openGraph: {
    title: 'LazyLotto Agent',
    description:
      'Autonomous lottery agent on Hedera. Authenticate to play, manage funds, and track prizes.',
    siteName: 'LazyLotto Agent',
    images: [
      {
        url: 'https://lsh-cache.b-cdn.net/twitterHD.png',
        width: 1200,
        height: 630,
      },
    ],
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    site: '@SuperheroesLazy',
    creator: '@SuperheroesLazy',
    images: ['https://lsh-cache.b-cdn.net/twitterHD.png'],
  },
  robots: {
    index: true,
    follow: false,
  },
};

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`dark ${heebo.variable} ${unbounded.variable} ${pressStart.variable}`}
    >
      <body className="min-h-screen bg-background font-sans">
        {/* Skip link — first focusable element on every page so keyboard
            and screen reader users can bypass the sidebar nav and jump
            straight to the main content. Visually hidden until focused
            (sr-only → focus:not-sr-only), then renders as a brand-gold
            chip in the top-left so it's unmissable when active.
            WCAG 2.4.1 (Bypass Blocks, Level A). */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:border-2 focus:border-brand focus:bg-background focus:px-4 focus:py-2 focus:font-pixel focus:text-[10px] focus:uppercase focus:tracking-wider focus:text-brand"
        >
          Skip to main content
        </a>
        <ToastProvider>
          <div className="flex min-h-screen">
            <Sidebar />
            <main id="main-content" className="flex flex-1 flex-col">
              {children}
            </main>
          </div>
        </ToastProvider>
      </body>
    </html>
  );
}
