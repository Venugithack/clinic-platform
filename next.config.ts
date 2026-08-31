import type { NextConfig } from 'next'

/**
 * A static export.
 *
 * The application used to be a Next server: the page and the API in one
 * process. It is two things now — these files, and the Edge Functions next to
 * the database — because a server that runs code on every request is the one
 * thing free hosting will not do, and this clinic's hosting has to stay free.
 *
 * `next build` writes plain HTML, CSS and JavaScript to `out/`. Cloudflare
 * serves that for nothing, as it did for the application before this one.
 *
 * The `headers()` block that used to live here is gone: a static export has no
 * server to set them. They are in `public/_headers` instead, which Cloudflare
 * applies at the edge — same headers, applied by the thing actually serving.
 */
const nextConfig: NextConfig = {
  output: 'export',
  turbopack: {
    root: process.cwd(),
  },
  // No image optimiser without a server; the clinic mark is already a sized PNG.
  images: { unoptimized: true },
}

export default nextConfig
