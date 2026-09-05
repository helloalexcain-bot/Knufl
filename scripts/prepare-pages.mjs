import { copyFile, writeFile } from 'node:fs/promises';

await copyFile('dist-pages/index.html', 'dist-pages/404.html');
await writeFile('dist-pages/.nojekyll', '');
