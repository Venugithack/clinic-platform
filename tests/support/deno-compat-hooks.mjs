/**
 * Letting Node run the Edge Functions' own code.
 *
 * The backend is Deno. Its imports say `npm:postgres@3.4.5`, which Node's
 * resolver has never heard of, so the only way to test `commands.ts` under
 * `node --test` was not to — and that is how the whole backend came to have
 * four unit tests, none of which touch it.
 *
 * Rewriting the specifier is the entire trick. `npm:postgres@3.4.5` becomes
 * `postgres`, which resolves out of this repository's own node_modules where a
 * compatible copy already sits as a devDependency. The version suffix is
 * dropped rather than checked: pinning it here would mean a lockfile bump
 * silently stops the tests running, and the version that matters is the one
 * Deno fetches at deploy time, which this file cannot influence either way.
 *
 * What this does NOT do is make Node into Deno. It makes the import graph
 * resolvable. Anything reaching for a Deno API needs the shim in register.mjs.
 */
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('npm:')) {
    const rest = specifier.slice(4)
    // Scoped packages start with '@', so only a LATER '@' is a version.
    const at = rest.lastIndexOf('@')
    return next(at > 0 ? rest.slice(0, at) : rest, context)
  }
  return next(specifier, context)
}
