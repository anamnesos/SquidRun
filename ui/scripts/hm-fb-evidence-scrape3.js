#!/usr/bin/env node
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const saveDir = 'D:/projects/Korean Fraud/09-Social-Media-Storefronts/captures-20260421';
if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

const targets = [
  { url: 'https://www.facebook.com/groups/bagsshopperskorea', name: 'bags-shoppers-korea-group' },
  { url: 'https://www.facebook.com/profile.php?id=100063898541933', name: 'bags-shoppers-korea-page' },
  { url: 'https://www.facebook.com/carriejasmine.lumibao', name: 'carrie-lumibao' },
  { url: 'https://www.facebook.com/carriejasmine.lumibao/photos', name: 'carrie-lumibao-photos' },
  { url: 'https://www.facebook.com/carriejasmine.lumibao/about', name: 'carrie-lumibao-about' },
  { url: 'https://www.facebook.com/jhem.aviso', name: 'kang-jimmelyn' },
  { url: 'https://www.facebook.com/jhem.aviso/about', name: 'kang-jimmelyn-about' },
  { url: 'https://www.facebook.com/qeline.quejada/videos', name: 'qeline-personal-videos' },
];

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 1440, height: 900 });

  for (const t of targets) {
    try {
      console.log('Fetching:', t.name);
      await page.goto(t.url, { waitUntil: 'networkidle', timeout: 25000 });
      await page.waitForTimeout(2000);
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
      const closeBtn = await page.$('[aria-label="Close"]').catch(() => null);
      if (closeBtn) { await closeBtn.click().catch(() => {}); await page.waitForTimeout(500); }

      // Scroll down to load more content
      await page.evaluate(() => window.scrollBy(0, 1500)).catch(() => {});
      await page.waitForTimeout(1500);

      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 8000));
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
