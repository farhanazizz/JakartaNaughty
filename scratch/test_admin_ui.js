const puppeteer = require('puppeteer');

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
    await new Promise(r => setTimeout(r, 600));

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

  console.log('Clicking "+ Tambah User Baru" button in Kelola User...');
  await page.click('#btn-users-create-user');
  await new Promise(r => setTimeout(r, 500));

  let isModalOpen = await page.evaluate(() => {
    const m = document.getElementById('modal-create-user');
    return m && !m.classList.contains('hidden');
  });
  console.log('Create User Modal opened:', isModalOpen);

  // Close modal
  console.log('Closing modal via closeModal()...');
  await page.evaluate(() => closeModal('modal-create-user'));
  await new Promise(r => setTimeout(r, 300));
  let isModalClosed = await page.evaluate(() => {
    const m = document.getElementById('modal-create-user');
    return m && m.classList.contains('hidden');
  });
  console.log('Create User Modal closed:', isModalClosed);

  // 2. Test Quick Action Button in Overview
  console.log('\n--- TESTING QUICK ACTION BUTTONS ---');
  await page.click('#tab-btn-overview');
  await new Promise(r => setTimeout(r, 500));

  console.log('Clicking Quick Action: Kelola Saldo Kredit...');
  await page.click('#btn-quick-credits');
  await new Promise(r => setTimeout(r, 500));
  let creditsVisible = await page.evaluate(() => {
    const pane = document.getElementById('pane-credits');
    return pane && !pane.classList.contains('hidden');
  });
  console.log('Credits Pane opened from quick button:', creditsVisible);

  console.log('Clicking Quick Action: GPU Fleet...');
  await page.click('#tab-btn-overview');
  await new Promise(r => setTimeout(r, 500));
  await page.click('#btn-quick-gpu');
  await new Promise(r => setTimeout(r, 500));
  let gpuVisible = await page.evaluate(() => {
    const pane = document.getElementById('pane-gpu');
    return pane && !pane.classList.contains('hidden');
  });
  console.log('GPU Pane opened from quick button:', gpuVisible);

  // 3. Test Ping in GPU Fleet
  console.log('\n--- TESTING PING BUTTON ---');
  const pingBtn = await page.$('#btn-ping-test');
  if (pingBtn) {
    await page.evaluate(() => {
      document.getElementById('ping-url-input').value = 'http://151.237.25.16:21875?token=5795a3e13d4ecdf0f45264e3f3fbf2a3166e447319af28a6fb70ce945dc9eb79';
    });
    await pingBtn.click();
    console.log('Waiting for ping response...');
    await new Promise(r => setTimeout(r, 2500));
    const pingResult = await page.evaluate(() => {
      const box = document.getElementById('ping-result-box');
      return box ? box.textContent : 'NO_BOX';
    });
    console.log('Ping Result in UI:', pingResult);
  }

  console.log('\n--- CONSOLE LOGS SUMMARY ---');
  console.log(`Total Logs: ${consoleLogs.length}`);
  console.log(`Total Errors: ${consoleErrors.length}`);

  if (consoleErrors.length > 0) {
    console.log('\n❌ CONSOLE ERRORS:');
    console.log(consoleErrors.join('\n'));
  } else {
    console.log('\n✅ PERFECT: ZERO CONSOLE ERRORS ON ALL CLICKS AND ACTIONS!');
  }

  await browser.close();
  console.log('=== TEST FINISHED SUCCESSFULLY ===');
}

runBrowserTest().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
