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

  /**
   * A static export, and it widens the §7 exit ramp rather than narrowing it.
   *
   * This is not host-specific configuration — it is the absence of it. `next
   * build` writes plain HTML/CSS/JS to `out/`, which Cloudflare, Netlify, a
   * Mumbai VPS or an S3 bucket all serve without an adapter, a Worker or a
   * Node process. The app was already 25-of-27 client components with no
   * server actions and no route handlers, so nothing was rendering on a server
   * that needed one.
   *
   * What it buys on the free tier is the two ceilings HOSTING.md §2 was going
   * to have to live under: a Worker's 3 MB compressed bundle and its 10 ms CPU
   * budget per request. Static assets have neither.
   *
   * The cost is paid in routing: a dynamic route cannot be exported without
   * generateStaticParams(), and appointment/prescription/patient ids are not
   * known at build time. Those five screens take their id from the query
   * string instead — see the note in each.
   */
  output: 'export',
};

export default nextConfig;
