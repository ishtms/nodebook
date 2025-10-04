import JsonLd, { homepageSchema } from "@/components/JsonLd";
import { Bricolage_Grotesque, IBM_Plex_Sans_Condensed } from "next/font/google";
import Image from "next/image";
import { Footer, Layout, Navbar } from "nextra-theme-docs";
import "nextra-theme-docs/style.css";
import { Head } from "nextra/components";
import { getPageMap } from "nextra/page-map";
import "katex/dist/katex.min.css";
import "../docs.css";
const bricolageGrotesque = Bricolage_Grotesque({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700", "800"],
  variable: "--font-bricolage",
  display: "swap",
});

const ibmPlexSansCondensed = IBM_Plex_Sans_Condensed({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-ibm-plex",
  display: "swap",
});

export const metadata = {
  title: {
    // default: "NodeBook | Master Node.js - Complete Guide to Node.js Development",
    template: "%s | NodeBook",
  },
  description:
    "Learn and Master the complex parts of the Node.js Runtime. From V8's Turbofan optimizer to production deployments. Each chapter includes hands-on labs, real-world examples, and performance insights. The definitive guide to becoming a Node.js expert.",
  keywords: [
    "NodeBook",
    "Node.js",
    "JavaScript",
    "Node.js book",
    "Node.js tutorial",
    "Node.js guide",
    "learn Node.js",
    "Node.js programming",
    "backend development",
    "server-side JavaScript",
    "V8 engine",
    "npm",
    "Express.js",
    "Node.js best practices",
    "Node.js performance",
    "async programming",
    "event loop",
    "Node.js certification",
    "full-stack development",
    "web development",
    "API development",
    "microservices",
    "Node.js debugging",
    "Node.js deployment",
    "Node.js security",
  ],

  metadataBase: new URL("https://www.thenodebook.com"),
  applicationName: "NodeBook",
  authors: [{ name: "Ishtmeet Singh", url: "https://ishtms.com" }],
  creator: "Ishtmeet Singh",
  publisher: "NodeBook",
  generator: "Next.js",
  referrer: "origin-when-cross-origin",
  category: "Technology",

  openGraph: {
    title: "NodeBook | Master Node.js - Complete Guide to Node.js Development",
    description:
      "Learn and Master the complex parts of the Node.js Runtime. From V8's Turbofan optimizer to production deployments. Each chapter includes hands-on labs, real-world examples, and performance insights.",
    url: "https://www.thenodebook.com",
    siteName: "NodeBook",
    locale: "en_US",
    type: "website",
    images: [
      {
        url: "/nodebook_cover.jpg",
        width: 1200,
        height: 630,
        alt: "NodeBook - Master Node.js Development",
        type: "image/jpeg",
      },
      {
        url: "/logo.jpg",
        width: 800,
        height: 800,
        alt: "NodeBook Logo",
        type: "image/jpeg",
      },
    ],
  },

  twitter: {
    card: "summary_large_image",
    title: "NodeBook | Master Node.js - Complete Guide",
    description:
      "Learn and Master Node.js from fundamentals to advanced concepts. Hands-on labs, real-world examples, and performance insights included.",
    site: "@nodebook",
    creator: "@ishtmeet",
    images: ["/nodebook_cover.jpg"],
  },

  appleWebApp: {
    capable: true,
    title: "NodeBook",
    statusBarStyle: "black-translucent",
  },

  alternates: {
    canonical: "https://www.thenodebook.com",
    languages: {
      "en-US": "https://www.thenodebook.com",
    },
    types: {
      "application/rss+xml": "https://www.thenodebook.com/rss.xml",
    },
  },

  robots: {
    index: true,
    follow: true,
    nocache: false,
    googleBot: {
      index: true,
      follow: true,
      noimageindex: false,
      "max-video-preview": -1,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },

  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-16x16.png", type: "image/png", sizes: "16x16" },
      { url: "/favicon-32x32.png", type: "image/png", sizes: "32x32" },
    ],
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }],
    other: [
      {
        rel: "mask-icon",
        url: "/safari-pinned-tab.svg",
        color: "#000000",
      },
    ],
  },

  manifest: "/manifest.json",

  verification: {
    google: "your-google-verification-code",
    yandex: "your-yandex-verification-code",
    yahoo: "your-yahoo-verification-code",
    other: {
      me: ["your-email@example.com", "https://github.com/ishtms"],
    },
  },

  other: {
    "msapplication-TileColor": "#000000",
    "msapplication-config": "/browserconfig.xml",
    "theme-color": "#000000",
    "color-scheme": "light dark",
    "format-detection": "telephone=no",
    "mobile-web-app-capable": "yes",
    "apple-mobile-web-app-capable": "yes",
    "apple-mobile-web-app-status-bar-style": "black-translucent",
    "og:image:width": "1200",
    "og:image:height": "630",
    "og:image:type": "image/jpeg",
  },
};

export default async function DocsLayout({ children, ...params }) {
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning className={`${bricolageGrotesque.className} ${ibmPlexSansCondensed.variable}`}>
      <Head></Head>
      <body>
        <JsonLd data={homepageSchema} />
        <Layout
          pageMap={await getPageMap()}
          docsRepositoryBase="https://github.com/ishtms/nodebook"
          footer={
            <Footer>
              <div className="text-center py-4">© {new Date().getFullYear()} Ishtmeet Singh. All rights reserved.</div>
            </Footer>
          }
          banner={true}
          darkMode={true}
          editLink={true}
          toc={{
            float: true,
          }}
          navbar={
            <>
              <Navbar
                logoLink="/"
                logo={<Image className="rounded-full" src="/logo.jpg" alt="Logo" width={32} height={32} />}
                projectLink="https://github.com/ishtms/nodebook"
              ></Navbar>
            </>
          }
        >
          {children}
        </Layout>
        <script
          defer
          src="https://static.cloudflareinsights.com/beacon.min.js"
          data-cf-beacon='{"token": "eb4852144db84a2b93d2bcb357a28dc1"}'
        ></script>
      </body>
    </html>
  );
}
