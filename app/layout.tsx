import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({ subsets: ['latin'] });

export const metadata: Metadata = {
  title: 'Graph Gardener - GearGraph Maintenance',
  description: 'Autonomous graph maintenance system for the GearGraph database',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className={inter.className}>
        <div className="min-h-screen bg-gray-50">
          <header className="bg-white shadow-sm border-b">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <span className="text-2xl">🌱</span>
                  <h1 className="text-xl font-semibold text-gray-900">Graph Gardener</h1>
                </div>
                <nav className="flex space-x-4">
                  <a
                    href="/"
                    className="text-gray-600 hover:text-gray-900 px-3 py-2 rounded-md text-sm font-medium"
                  >
                    Chat
                  </a>
                  <a
                    href="/api/system/status"
                    className="text-gray-600 hover:text-gray-900 px-3 py-2 rounded-md text-sm font-medium"
                  >
                    Status
                  </a>
                </nav>
              </div>
            </div>
          </header>
          <main>{children}</main>
        </div>
      </body>
    </html>
  );
}
