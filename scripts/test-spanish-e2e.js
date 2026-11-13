// Public atlas data; locale preference stays in the browser.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const artifacts = '.audit/ui/45';
mkdirSync(artifacts, { recursive: true });
const server = spawn(process.execPath, ['backend/src/local-server.js'], {
  env: { ...process.env, PORT: '8097' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Startup timeout')), 15000);
    server.on('exit', () => { clearTimeout(timer); reject(Error('Server exited')); });
    server.stdout.on('data', (b) => { if (b.toString().includes('Truth2Power is running')) { clearTimeout(timer); resolve(); } });
  });
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('http://127.0.0.1:8097/?year=2025');
  await page.locator('.legend-item').first().waitFor();
  if (process.env.CAPTURE_BEFORE) {
    await page.screenshot({ path: `${artifacts}/before-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: `${artifacts}/before-mobile.png`, fullPage: true });
  } else {
    await page.getByRole('button', { name: 'Español', exact: true }).click();
    await page.getByRole('heading', { name: 'Cumplimiento de los hospitales de Nueva York', exact: true }).waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'), 'es');
    await page.getByRole('button', { name: /5 ★.*Cumplimiento total/ }).click();
    await page.getByText('Mostrando 5 estrellas ·', { exact: false }).waitFor();
    await page.getByRole('button', { name: 'English', exact: true }).click();
    assert.equal(await page.getByRole('button', { name: /5 ★.*Fully compliant/ }).getAttribute('aria-pressed'), 'true');
    await page.getByRole('button', { name: 'Español', exact: true }).click();
    await page.getByRole('button', { name: 'Mostrar todos', exact: true }).click();
    for (const [size, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
      await page.setViewportSize({ width, height });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await page.evaluate(() => document.querySelector('header').getBoundingClientRect().bottom <= document.querySelector('h1').getBoundingClientRect().top), true);
      await page.screenshot({ path: `${artifacts}/after-${size}.png`, fullPage: true });
    }
    const search = page.getByRole('searchbox', { name: 'Buscar un hospital o una ciudad' });
    await search.fill('SYN-no-hospital');
    await page.getByText('No se encontraron hospitales.').waitFor();
    await search.fill('Ellenville');
    await search.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.locator('.detail h1').filter({ hasText: 'Ellenville' }).waitFor();
    await page.getByRole('link', { name: 'Solicitar asistencia financiera del hospital ↗', exact: true }).waitFor();
    assert.match(page.url(), /lang=es/);
    await page.reload();
    await page.getByRole('button', { name: '← Volver al mapa y las calificaciones estatales', exact: true }).waitFor();
    await page.getByRole('button', { name: 'English', exact: true }).click();
    await page.getByRole('button', { name: '← Back to statewide map and ratings', exact: true }).waitFor();
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    assert.match(page.url(), /hospital=1002/);
    await page.goto('http://127.0.0.1:8097/?lang=es');
    await page.getByRole('button', { name: 'Acercar' }).waitFor();
    await page.goto('http://127.0.0.1:8097/');
    await page.getByRole('heading', { name: 'Calificaciones estatales', exact: true }).waitFor();
    await page.route('**/api/hospitals', (route) => route.fulfill({ status: 503, body: 'SYN unavailable' }));
    await page.goto('http://127.0.0.1:8097/?lang=es');
    await page.getByText('No se pudieron cargar los datos del mapa.', { exact: false }).waitFor();
    await page.unroute('**/api/hospitals');
    await page.getByRole('button', { name: 'Volver a intentar', exact: true }).click();
    await page.getByRole('heading', { name: 'Calificaciones estatales', exact: true }).waitFor();
    const blocked = await browser.newPage();
    await blocked.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new Error('SYN blocked storage'); };
      Storage.prototype.setItem = () => { throw new Error('SYN blocked storage'); };
    });
    await blocked.goto('http://127.0.0.1:8097/?lang=es');
    await blocked.getByRole('heading', { name: 'Calificaciones estatales', exact: true }).waitFor();
    await blocked.getByRole('button', { name: 'English', exact: true }).click();
    await blocked.getByRole('heading', { name: 'Statewide ratings', exact: true }).waitFor();
    await blocked.close();
    assert.deepEqual(errors, []);
    console.log('Spanish UI passed: switch, persistence, deep links, keyboard search, filters, labels and desktop/mobile layout.');
  }
} finally {
  await browser?.close();
  server.kill();
}
