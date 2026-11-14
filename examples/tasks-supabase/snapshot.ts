// This demo has no live database. Edit the invented catalog, then canonicalize it locally.
import { readFileSync, writeFileSync } from 'node:fs';
const path = new URL('target/demo-schema.json', import.meta.url);
writeFileSync(path, `${JSON.stringify(JSON.parse(readFileSync(path, 'utf8')), null, 1)}\n`);
console.log('Canonicalized the authored database catalog; no database connection used.');
