import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://helloalexcain-bot.github.io/Knufl/'),
  title: 'Knufl — Get stronger together',
  description: 'A warm, local-first fitness companion that trains alongside you.',
  openGraph: {
    title: 'Knufl — Get stronger together',
    description: 'A lovable training companion for following through, one practice day at a time.',
    images: [{ url: '/Knufl/og.png', width: 1200, height: 630, alt: 'Knufl — Get stronger together' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Knufl — Get stronger together',
    description: 'A lovable training companion for following through, one practice day at a time.',
    images: ['/Knufl/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
