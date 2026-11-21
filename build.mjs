import { mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('dist/server', { recursive: true });
const [worker, feeds, html, css, script] = await Promise.all(
  ['worker.mjs', 'feeds.mjs', 'index.html', 'style.css', 'app.js'].map(path => readFile(path, 'utf8'))
);
await writeFile('dist/server/index.js', feeds + '\n' + worker + '\n' +
  'const page = ' + JSON.stringify(html) + ';\n' +
  'const css = ' + JSON.stringify(css) + ';\n' +
  'const script = ' + JSON.stringify(script) + ';\n');
