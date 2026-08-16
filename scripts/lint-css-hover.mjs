#!/usr/bin/env node
/**
 * TABLET.md §8: CI fails on `:hover`-only affordances outside
 * `@media (hover: hover)`.
 *
 * The ESLint rule catches the Tailwind form in JSX. This catches the other
 * half — a `:hover` rule written directly in CSS, which ESLint never sees. On a
 * device with no cursor, a hover-only affordance is not subtle; it is invisible.
 */
import { globSync, readFileSync } from 'node:fs';

const files = globSync('{app,components}/**/*.css');

let failures = 0;

for (const file of files) {
  const css = readFileSync(file, 'utf8');
  const lines = css.split('\n');

  // Track whether we are inside an @media block that requires a real pointer.
  let hoverSafeDepth = 0;
  let depth = 0;

  lines.forEach((line, index) => {
    const opensHoverMedia = /@media[^{]*\(\s*hover\s*:\s*hover\s*\)/.test(line);

    if (opensHoverMedia) hoverSafeDepth = depth + 1;

    if (/:hover\b/.test(line) && !opensHoverMedia && hoverSafeDepth === 0) {
      console.error(
        `${file}:${index + 1}  :hover outside @media (hover: hover) — ${line.trim()}`,
      );
      failures += 1;
    }

    depth += (line.match(/{/g) ?? []).length;
    depth -= (line.match(/}/g) ?? []).length;

    if (hoverSafeDepth > 0 && depth < hoverSafeDepth) hoverSafeDepth = 0;
  });
}

if (failures > 0) {
  console.error(
    `\n${failures} hover-only affordance(s). There is no cursor on a tablet (TABLET.md §2 rule 1).`,
  );
  process.exit(1);
}

console.log(`css hover check: ${files.length} file(s) clean`);
