// The synthetic backend's hand-authored OpenAPI is its committed contract input.
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const home = fileURLToPath(new URL('.', import.meta.url));
mkdirSync(`${home}specs/contracts`, { recursive: true });
copyFileSync(`${home}target/openapi.json`, `${home}specs/contracts/library.openapi.json`);
console.log('Refreshed library contract from the local target.');
