import type { NextConfig } from 'next';

/**
 * Kept deliberately plain.
 *
 * HOSTING.md §7: "build output is standard Next" is one of the five guarantees
 * that make starting on a free tier defensible rather than reckless. The moment
 * this file grows host-specific configuration, the one-day exit ramp to Vercel
 * or a Mumbai VPS stops being a configuration change.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  typedRoutes: true,
};

export default nextConfig;
