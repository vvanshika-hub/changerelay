import { mkdir, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Keep the public output empty: the one HTTP adapter serves only its explicit allowlist.
// Explicit includeFiles in vercel.json bundles public/ and the SDK's browser asset.
await mkdir(fileURLToPath(new URL('./static/', import.meta.url)), { recursive: true });
await access(fileURLToPath(new URL('../public/index.html', import.meta.url)));
await access(fileURLToPath(new URL('../node_modules/viasocket-apps/dist/esm/browser.js', import.meta.url)));
console.log('ChangeRelay function assets are ready.');
