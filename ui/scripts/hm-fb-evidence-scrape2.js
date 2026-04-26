#!/usr/bin/env node
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const saveDir = 'D:/projects/Korean Fraud/09-Social-Media-Storefronts/captures-20260421';

const targets = [
  { url: 'https://www.facebook.com/qeline.quejada', name: 'qeline-personal-profile' },
  { url: 'https://www.facebook.com/qeline.quejada/photos', name: 'qeline-personal-photos' },
  { url: 'https://www.facebook.com/qeline.quejada/about', name: 'qeline-personal-about' },
  { url: 'https://www.facebook.com/people/문해윤/pfbid02pBfs9hRbGgcCm9yk6EEUwNfPRpcL72JeG36M5qCWH1XR6MJkAvv5MGgfaCuVaaU3l/', name: 'moon-haeyun-personal' },
  { url: 'https://www.facebook.com/eva.bernardo.54/photos', name: 'eva-bernardo-photos' },
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });

  for (const t of targets) {
    try {
      console.log('Fetching:', t.name);
      await page.goto(t.url, { waitUntil: 'networkidle', timeout: 20000 });
      await page.waitForTimeout(2000);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);

      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 5000));
      const links = await page.evaluate(() =>
        Array.from(document.querySelectorAll('a[href]'))
          .map(a => ({ text: a.innerText.trim().substring(0, 80), href: a.href }))
          .filter(l => l.href && !l.href.includes('javascript'))
          .slice(0, 60)
      );

      fs.writeFileSync(path.join(saveDir, t.name + '.txt'), bodyText);
      fs.writeFileSync(path.join(saveDir, t.name + '.json'), JSON.stringify({ url: t.url, bodyText, links }, null, 2));
      await page.screenshot({ path: path.join(saveDir, t.name + '.png'), fullPage: false });
      console.log('SAVED:', t.name, '| chars:', bodyText.length);
    } catch (e) {
      console.log('ERROR:', t.name, e.message.substring(0, 120));
    }
  }

  await browser.close();
  console.log('ALL DONE');
})();
