import { app } from 'electron';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Resolve a path to an `extraResources` asset that works in both dev and
 * packaged builds.
 *
 * - Dev:       `<repo>/out/main/index.js` lives at the build output, and the
 *              repo's `resources/` directory sits two levels above.
 * - Packaged: `extraResources` are copied to `process.resourcesPath`
 *              (Contents/Resources on macOS).
 */
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export function resolveResource(...segments: string[]): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, ...segments);
  }
  // out/main/index.js → repo root
  return join(__dirname, '..', '..', 'resources', ...segments);
}
