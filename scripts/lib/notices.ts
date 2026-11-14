// The third-party code the viewer bundles (three.js and the font packages viewer/src/fonts.ts imports) and the files that
// carry their original copyright and license text. Shared by the package build (scripts/build-lib.ts → dist/licenses/)
// and the site build (scripts/publish-specs.ts → viewer/public/licenses/, which Vite copies into viewer/dist/).
import { copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The font stylesheets viewer/src/fonts.ts imports. */
export const fontImports = (): string[] =>
    [...readFileSync(join(root, 'viewer/src/fonts.ts'), 'utf8').matchAll(/^import '([^']+\.css)';/gm)].map((m) => m[1]);

/** The packages whose code or files ship with the viewer. */
export const noticePackages = (): string[] => ['three', ...new Set(fontImports().map((s) => s.split('/').slice(0, 2).join('/')))];

/** A package's notice file name: `three.txt`, `ibm-plex-sans.txt`, … */
export const noticeName = (pkg: string): string => `${pkg.replace('@fontsource/', '')}.txt`;

/** The original LICENSE text of an installed package. */
export const licenseOf = (pkg: string): string => readFileSync(join(root, 'node_modules', pkg, 'LICENSE'), 'utf8');

/** Writes every bundled package's original LICENSE into `dir` (emptied first), plus arch-map's own as `arch-map.txt`. */
export function copyNotices(dir: string, { own = false }: { own?: boolean } = {}): string[] {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const names = noticePackages().map((pkg) => {
        copyFileSync(join(root, 'node_modules', pkg, 'LICENSE'), join(dir, noticeName(pkg)));
        return noticeName(pkg);
    });
    if (own) {
        copyFileSync(join(root, 'LICENSE'), join(dir, 'arch-map.txt'));
        names.push('arch-map.txt');
    }
    return names;
}
