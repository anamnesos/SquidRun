const { chromium } = require('../ui/node_modules/playwright');
const path = require('path');
const fs = require('fs');

const DOWNLOAD_DIR = 'D:/projects/Korean Fraud/email-attachments';
const GMAIL_URL = 'https://mail.google.com/mail/u/0/#all/19d2c76c68a5dff6';
const CHROME_USER_DATA = 'C:/Users/James Kim/AppData/Local/Google/Chrome/User Data';

async function main() {
  // Ensure download directory exists
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }

  console.log('Launching Chrome with existing profile...');

  const context = await chromium.launchPersistentContext(CHROME_USER_DATA, {
    channel: 'chrome',
    headless: false,
    args: ['--profile-directory=Default'],
    acceptDownloads: true,
    viewport: { width: 1280, height: 900 }
  });

  const page = context.pages()[0] || await context.newPage();

  console.log('Navigating to Gmail...');
  await page.goto(GMAIL_URL, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(3000);

  // Check if we're on the login page
  const url = page.url();
  if (url.includes('accounts.google.com')) {
    console.log('ERROR: Not logged in to Gmail. Need manual login.');
    await context.close();
    return;
  }

  console.log('On Gmail. Looking for download all button...');

  // Try to find and click "Download all attachments" button
  // Gmail uses aria-label for the download all button
  try {
    // Wait for email to load
    await page.waitForTimeout(5000);

    // Look for the download all attachments icon/button
    // Gmail's download all button is typically an icon with specific aria-label
    const downloadAllBtn = await page.$('[data-tooltip="Download all attachments"]');
    if (downloadAllBtn) {
      console.log('Found "Download all" button, clicking...');
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 60000 }),
        downloadAllBtn.click()
      ]);
      const savePath = path.join(DOWNLOAD_DIR, download.suggestedFilename());
      await download.saveAs(savePath);
      console.log('Downloaded:', savePath);
    } else {
      console.log('No "Download all" button found. Trying alternative approach...');

      // Try to find individual attachment download links
      const attachmentElements = await page.$$('[data-tooltip*="Download"]');
      console.log('Found', attachmentElements.length, 'download elements');

      for (let i = 0; i < attachmentElements.length; i++) {
        try {
          const tooltip = await attachmentElements[i].getAttribute('data-tooltip');
          console.log('Element', i, ':', tooltip);
        } catch (e) {
          // ignore
        }
      }

      // Take screenshot for debugging
      await page.screenshot({ path: path.join(DOWNLOAD_DIR, '_gmail-screenshot.png'), fullPage: true });
      console.log('Screenshot saved for debugging');
    }
  } catch (err) {
    console.error('Error during download:', err.message);
    await page.screenshot({ path: path.join(DOWNLOAD_DIR, '_gmail-error.png') });
  }

  // Keep browser open briefly
  await page.waitForTimeout(3000);
  await context.close();
  console.log('Done.');
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
