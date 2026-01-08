/**
 * Next.js Middleware for CORS support
 * Allows cross-origin requests from the GearShack app
 */

import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

// Allowed origins for CORS
const ALLOWED_ORIGINS = [
  'https://www.gearshack.app',
  'https://app.gearshack.app',
  'https://gearshack.app',
  'http://localhost:3000',
  'http://localhost:5173',
];

// Check if origin is allowed (explicit list or any gearshack.app subdomain)
function isOriginAllowed(origin: string): boolean {
  if (ALLOWED_ORIGINS.includes(origin)) return true;
  // Allow any subdomain of gearshack.app
  try {
    const url = new URL(origin);
    return url.hostname === 'gearshack.app' || url.hostname.endsWith('.gearshack.app');
  } catch {
    return false;
  }
}

export function middleware(request: NextRequest) {
  const origin = request.headers.get('origin') ?? '';
  const isAllowedOrigin = isOriginAllowed(origin);

  // Handle preflight requests
  if (request.method === 'OPTIONS') {
    const response = new NextResponse(null, { status: 204 });

    if (isAllowedOrigin) {
      response.headers.set('Access-Control-Allow-Origin', origin);
    }
    response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    response.headers.set('Access-Control-Max-Age', '86400');

    return response;
  }

  // Handle actual requests
  const response = NextResponse.next();

  if (isAllowedOrigin) {
    response.headers.set('Access-Control-Allow-Origin', origin);
  }
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  return response;
}

// Apply middleware to API routes
export const config = {
  matcher: '/api/:path*',
};
