// The site's entry (index.html): the fonts, then the map mounted with the site's options (site.ts).
import './fonts.ts';
import { startSite } from './site.ts';

await startSite(document.getElementById('app')!);
