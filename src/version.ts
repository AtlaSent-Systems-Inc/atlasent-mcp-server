/**
 * Package version, read from package.json at runtime so serverInfo, the
 * User-Agent header, and registry listings never drift from the published
 * release. (The previous hardcoded literal reported 2.11.0 from 2.12.0.)
 *
 * package.json sits one level above both src/ (tsx) and dist/ (built), and
 * npm always ships it in the tarball.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export const VERSION: string = (require("../package.json") as { version: string }).version;
