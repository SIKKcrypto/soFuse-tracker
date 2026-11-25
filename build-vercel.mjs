import { copyFile, lstat, mkdir, readdir } from 'node:fs/promises';
import { staticFiles } from './site-assets.mjs';

const directory = new URL('./dist-vercel/', import.meta.url);
const filenames = new Set(Object.values(staticFiles).map(([filename]) => filename));
await mkdir(directory, { recursive: true });
if (!(await lstat(directory)).isDirectory()) throw new Error('Expected dist-vercel to be a regular directory.');
for (const entry of await readdir(directory, { withFileTypes: true })) {
  if (!entry.isFile() || !filenames.has(entry.name)) {
    throw new Error('Unexpected entry in dist-vercel: ' + entry.name);
  }
}
await Promise.all([...filenames].map(filename => copyFile(
  new URL(filename, import.meta.url), new URL(filename, directory)
)));
