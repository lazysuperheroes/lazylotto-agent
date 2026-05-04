import './styles/globals.css';
import type { Metadata, Viewport } from 'next';
import { Heebo, Unbounded, Press_Start_2P } from 'next/font/google';
import { Sidebar } from './components/Sidebar';
import { ToastProvider } from './components/Toast';
import { ThemeBoot } from './components/ThemeBoot';

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

const SITE_URL =
  process.env.NEXT_PUBLIC_APP_URL || 'https://testnet-agent.lazysuperheroes.com';

const OG_DESCRIPTION =
  'Autonomous lottery agent on Hedera. Authenticate to play, manage funds, and track prizes.';

const OG_IMAGE = {
  url: 'https://lsh-cache.b-cdn.net/twitterHD.png',
  width: 1200,
  height: 630,
  alt: 'LazyLotto Agent — autonomous lottery agent on Hedera',
};

export const metadata: Metadata = {
  title: {
    default: 'LazyLotto Agent',
    template: '%s | LazyLotto Agent',
  },
  description: OG_DESCRIPTION,
  metadataBase: new URL(SITE_URL),
  icons: {
    icon: '/favicon.svg',
  },
  openGraph: {
    title: 'LazyLotto Agent',
    description: OG_DESCRIPTION,
    siteName: 'LazyLotto Agent',
    url: SITE_URL,
    locale: 'en_US',
    images: [OG_IMAGE],
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    site: '@SuperheroesLazy',
    creator: '@SuperheroesLazy',
    title: 'LazyLotto Agent',
    description: OG_DESCRIPTION,
    images: [{ url: OG_IMAGE.url, alt: OG_IMAGE.alt }],
  },
  // index=true + follow=false is intentional: the landing page is fine
  // for crawlers, but the auth-walled surfaces (/dashboard, /audit,
  // /admin) shouldn't be indexed via outbound links from here.
  robots: {
    index: true,
    follow: false,
  },
};

// themeColor lives on `viewport` per Next 14+. Matches --color-background
// in app/styles/globals.css so mobile chrome (Safari address bar etc.)
// blends with the page.
export const viewport: Viewport = {
  themeColor: '#09090b',
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
        {/* ThemeBoot reads the user's calm/comic preference from
            localStorage and applies `data-theme="calm"` to <html>
            so the calm-mode CSS variants in globals.css take effect.
            Renders nothing — pure side effect on mount. */}
        <ThemeBoot />
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
