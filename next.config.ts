import type { NextConfig } from "next";
import { withPayload } from "@payloadcms/next/withPayload";

const nextConfig: NextConfig = {
  // NOTE: The previous OpenNext/Cloudflare comment was for @opennextjs/cloudflare deploys.
  // For standard Vercel deployment this is a normal Next.js + Payload setup.
  // If you also deploy to Cloudflare in future, you can use @opennextjs/cloudflare adapter separately.

  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: '**.supabase.co',
      },
      {
        protocol: 'https',
        hostname: '**.r2.cloudflarestorage.com',
      },
      // Add your R2 public domain if using Cloudflare R2 for media
      // { protocol: 'https', hostname: 'your-bucket.your-domain.com' },
    ],
    // Support for Payload media URLs served from your domain
    localPatterns: [
      {
        pathname: '/api/media/file/**',
      },
    ],
  },

  // Recommended for Turbopack / workspace with multiple lockfiles warning
  turbopack: {
    root: process.cwd(),
  },

  reactStrictMode: true,
  poweredByHeader: false,

  experimental: {
    optimizePackageImports: ['lucide-react'],
  },

  // Headers de seguridad portables: se aplican en Vercel, Railway y cualquier
  // hosting Node (antes vivían sólo en vercel.json, que Railway no lee).
  async headers() {
    // La CSP se emite por request en `proxy.ts` porque lleva un nonce único.
    // Acá quedan solo los headers estáticos.
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-XSS-Protection', value: '1; mode=block' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(self), payment=()',
          },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Resource-Policy', value: 'same-site' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=31536000; includeSubDomains',
          },
        ],
      },
    ];
  },
};

export default withPayload(nextConfig);
