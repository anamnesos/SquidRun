#!/usr/bin/env node
// Emergency evidence scrape before deletion
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const saveDir = 'D:/projects/Korean Fraud/09-Social-Media-Storefronts/captures-20260421';
if (!fs.existsSync(saveDir)) fs.mkdirSync(saveDir, { recursive: true });

const targets = [
  { url: 'https://www.facebook.com/people/QelineShop-Live/61557382537110/', name: 'qelineshop-live-main' },
  { url: 'https://www.facebook.com/people/QelineShop-Live/61557382537110/photos', name: 'qelineshop-live-photos' },
  { url: 'https://www.facebook.com/people/QelineShop-Live/61557382537110/about', name: 'qelineshop-live-about' },
  { url: 'https://www.facebook.com/share/18Kvnm3quK/', name: 'moon-haeyun-branded-bags' },
  { url: 'https://www.facebook.com/qelinesbrandedshop/', name: 'qelines-branded-shop-ph' },
  { url: 'https://www.facebook.com/eva.bernardo.54', name: 'eva-bernardo' },
  { url: 'https://www.facebook.com/michelle.aviso.7', name: 'michelle-aviso' },
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

      // Dismiss login modals
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
      const closeBtn = await page.$('[aria-label="Close"]').catch(() => null);
      if (closeBtn) { await closeBtn.click().catch(() => {}); await page.waitForTimeout(500); }

      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 5000));
      const links = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('a[href]'))
          .map(a => ({ text: a.innerText.trim().substring(0, 80), href: a.href }))
          .filter(l => l.href && !l.href.includes('javascript'))
          .slice(0, 50);
      });

      fs.writeFileSync(path.join(saveDir, t.name + '.txt'), bodyText);
      fs.writeFileSync(path.join(saveDir, t.name + '.json'), JSON.stringify({ url: t.url, bodyText, links }, null, 2));
      await page.screenshot({ path: path.join(saveDir, t.name + '.png'), fullPage: false });
      console.log('SAVED:', t.name);
    } catch (e) {
      console.log('ERROR:', t.name, e.message.substring(0, 120));
    }
  }

  await browser.close();
  console.log('DONE');
})();
