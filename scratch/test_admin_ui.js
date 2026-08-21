const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function runBrowserTest() {
  console.log('=== STARTING PUPPETEER ADMIN UI TEST ===');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  const consoleErrors = [];
  const consoleLogs = [];

  page.on('console', msg => {
    const text = msg.text();
    consoleLogs.push(`[${msg.type()}] ${text}`);
    if (msg.type() === 'error') {
      consoleErrors.push(text);
    }
  });

  page.on('pageerror', err => {
    consoleErrors.push(`PageError: ${err.message}`);
  });

  console.log('1. Navigating to Admin Login...');
  await page.goto('https://jakarta.suntechnostore.com/admin/login.html?key=jakarta_naughty_admin_secret_key_88', {
    waitUntil: 'networkidle2'
  });

  console.log('2. Entering credentials...');
  await page.type('#admin-username-input', 'admin');
  await page.type('#admin-pass-input', 'admin12345');
  
  console.log('3. Submitting login form...');
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(e => console.log('Navigation wait:', e.message)),
    page.click('#btn-admin-login')
  ]);

  console.log('Current URL after login:', page.url());

  // Wait 2s for initial dashboard data to load
  await new Promise(r => setTimeout(r, 2000));

  console.log('\n--- TESTING TAB CLICKS ---');
  const tabs = ['overview', 'users', 'credits', 'security', 'gpu', 'history'];

  for (const tab of tabs) {
    console.log(`Testing click on tab: ${tab}...`);
    const btnSelector = `#tab-btn-${tab}`;
    const paneSelector = `#pane-${tab}`;

    const btnExists = await page.$(btnSelector);
    if (!btnExists) {
      console.error(`❌ Button ${btnSelector} NOT FOUND!`);
      continue;
    }

    await page.click(btnSelector);
    await new Promise(r => setTimeout(r, 1000));

    const isPaneVisible = await page.evaluate((sel) => {
      const pane = document.querySelector(sel);
      if (!pane) return 'NOT_FOUND';
      const isHidden = pane.classList.contains('hidden');
      const style = window.getComputedStyle(pane);
      return {
        hasHiddenClass: isHidden,
        display: style.display,
        visible: !isHidden && style.display !== 'none'
      };
    }, paneSelector);

    console.log(`Tab ${tab} result:`, isPaneVisible);
  }

  console.log('\n--- TESTING MODAL CLICKS ---');
  // 1. Open create user modal from Kelola User tab
  await page.click('#tab-btn-users');
  await new Promise(r => setTimeout(r, 500));

  console.log('Clicking "+ Tambah User Baru" button...');
  const openCreateUserBtn = await page.$('button[onclick="openCreateUserModal()"]');
  if (openCreateUserBtn) {
    await openCreateUserBtn.click();
    await new Promise(r => setTimeout(r, 500));
    const isModalOpen = await page.evaluate(() => {
      const m = document.getElementById('modal-create-user');
      return m && !m.classList.contains('hidden');
    });
    console.log('Create User Modal opened:', isModalOpen);

    // Click close modal
    console.log('Closing modal...');
    await page.evaluate(() => closeModal('modal-create-user'));
    const isModalClosed = await page.evaluate(() => {
      const m = document.getElementById('modal-create-user');
      return m && m.classList.contains('hidden');
    });
    console.log('Create User Modal closed:', isModalClosed);
  } else {
    console.error('❌ openCreateUserModal button not found!');
  }

  console.log('\n--- CONSOLE LOGS CAPTURED ---');
  console.log(consoleLogs.join('\n'));

  if (consoleErrors.length > 0) {
    console.log('\n❌ CONSOLE ERRORS DETECTED:');
    console.log(consoleErrors.join('\n'));
  } else {
    console.log('\n✅ ZERO CONSOLE ERRORS DETECTED!');
  }

  await browser.close();
  console.log('=== TEST FINISHED ===');
}

runBrowserTest().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
