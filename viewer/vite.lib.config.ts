// The package build of @arch-map/viewer (scripts/build-lib.ts runs it twice, then adds the types, fonts.css and the
// schemas): `--mode esm` — the ES modules `index.js`, `element.js`, `react.js` with three (a peer dependency: pinch
// depends on its internals) and react left to the page; `--mode iife` — `arch-map.iife.js`, one script with three
// bundled, the global `ArchMap`. Paths are relative to the repository root (the build runs there).
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';

const OUT = 'packages/viewer/dist';

export default defineConfig(({ mode }) => {
    const iife = mode === 'iife';
    return {
        publicDir: false,
        logLevel: 'warn',
        build: {
            outDir: OUT,
            emptyOutDir: !iife, // the ESM build runs first and starts from an empty dist
            target: 'es2022',
            minify: iife,
            sourcemap: !iife, // the ES modules' maps serve a bundler's debugging; the script's would embed three's sources (~3.8 MB)
            copyPublicDir: false,
            lib: iife
                ? { entry: 'viewer/src/index.ts', name: 'ArchMap', formats: ['iife'], fileName: () => 'arch-map.iife.js' }
                : { entry: { index: 'viewer/src/index.ts', element: 'viewer/src/element.ts', react: 'viewer/src/react.ts' }, formats: ['es'], fileName: (_f, name) => `${name}.js` },
            rolldownOptions: iife
                ? { output: { postBanner: `/*! three.js\n${readFileSync('node_modules/three/LICENSE', 'utf8')}\n*/` } }
                : { external: (id: string) => id === 'three' || id.startsWith('three/') || id === 'react' || id.startsWith('react/') },
        },
    };
});
