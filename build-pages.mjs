import { mkdir, readFile, writeFile } from 'node:fs/promises';
import './build.mjs';

const { default: worker } = await import('./dist/server/index.js');
const response = await worker.fetch(new Request('https://localhost/api/prices'));
const snapshot = await response.json();
if (!snapshot.sources.some(source => source.status === 'ok' && source.rows.length > 0)) {
  throw new Error('Không lấy được giá từ nguồn nào. Giữ bản Pages đã xuất bản trước đó.');
}

const policy = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'";
const html = (await readFile('index.html', 'utf8'))
  .replace('<meta charset="utf-8">', '<meta charset="utf-8">\n  <meta name="referrer" content="no-referrer">\n  <meta http-equiv="Content-Security-Policy" content="' + policy + '">')
  .replace('href="/style.css"', 'href="./style.css"')
  .replace('src="/app.js"', 'src="./app.js"')
  .replace('href="/"', 'href="./"')
  .replace('data-endpoint="/api/prices"', 'data-endpoint="./prices.json"')
  .replace('Trang kiểm tra bảng giá mỗi 60 giây khi đang mở.', 'GitHub Actions được lên lịch lấy giá mỗi 5 phút và có thể chạy trễ. Trang kiểm tra bản giá mới mỗi 60 giây khi đang mở.');

await mkdir('dist/pages', { recursive: true });
await Promise.all([
  writeFile('dist/pages/index.html', html),
  writeFile('dist/pages/style.css', await readFile('style.css')),
  writeFile('dist/pages/app.js', await readFile('app.js')),
  writeFile('dist/pages/prices.json', JSON.stringify(snapshot))
]);
console.log('Nguồn đã đồng bộ:', snapshot.sources.filter(source => source.status === 'ok').length);
