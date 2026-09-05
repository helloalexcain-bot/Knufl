import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Knufl — Your voice training companion',
  description: 'A warm, accurate voice companion for planning and recording real training.',
  openGraph: {
    title: 'Knufl — Your voice training companion',
    description: 'A lovable training companion for planning, recording and remembering real workouts.',
  },
  twitter: {
    card: 'summary',
    title: 'Knufl — Your voice training companion',
    description: 'A lovable training companion for planning, recording and remembering real workouts.',
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
