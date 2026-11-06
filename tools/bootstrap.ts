/**
 * Loaded with `--import` so the resolve hook is in place before any prototype module is imported.
 *
 *     node --experimental-transform-types --import ./tools/bootstrap.ts …
 */
import { installVendoredResolution } from '../src/harness/hooks.ts'

installVendoredResolution()
