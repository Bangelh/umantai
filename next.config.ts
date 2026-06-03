import type { NextConfig } from "next";
import { withPayload } from "@payloadcms/next/withPayload";

const NEXT_PUBLIC_SERVER_URL =
  process.env.NEXT_PUBLIC_SERVER_URL || 'https://umantai.com';

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
};

export default withPayload(nextConfig);
