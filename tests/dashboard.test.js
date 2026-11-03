'use strict';
// Dashboard in a real browser (Playwright, preinstalled Chromium). Skipped when playwright is not available.
// Screenshots are written to $AIPAGER_SCREENSHOT_DIR when set.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startTestHub, addNode, taskBody } = require('./helpers');

let chromium = null;
try { ({ chromium } = require('playwright')); } catch { /* not installed */ }
const shots = process.env.AIPAGER_SCREENSHOT_DIR;

test('dashboard: asleep machines, stuck tasks, approve node, deny approval, edit grace, enroll (T34)', { skip: !chromium, timeout: 120000 }, async () => {
  const hub = await startTestHub();
  const browser = await chromium.launch();
  try {
    const dev = await addNode(hub, 'dev-pc', { profiles: [] });
    const mac = await addNode(hub, 'macbook-hc', { power: 'laptop', os_: 'macos', arch: 'arm64', profiles: ['ios'], labels: { xcode: '16' } });
    const b = await addNode(hub, 'build-pc', { os_: 'windows', profiles: ['build'] });
    await addNode(hub, 'new-mac', { approve: false, power: 'laptop', os_: 'macos', arch: 'arm64' });
    void mac;
    hub.advance(42 * 60);
    await dev.heartbeat();
    await b.heartbeat();
    const q = await dev.client.post('/tasks', taskBody({ node: 'macbook-hc', agent: 'worker' }, { payload: { title: 'iOS 單元測試', profile: 'ios', instructions: 'run', dispatch: { on_unavailable: 'queue' } } }));
    const r = await dev.client.post('/tasks', taskBody({ node: 'build-pc', agent: 'worker' }, { payload: { title: '編譯 ERP', profile: 'build', instructions: 'build' } }));
    const c = await b.client.post('/tasks/claim', { profiles: ['build'] }, { query: { wait: 0 } });
    await b.client.post(`/tasks/${r.data.task_id}/progress`, { phase: 'started' });
    await hub.client(c.data.task_token).post('/approvals', { tool_name: 'Bash', tool_input: { command: 'git push origin relay/x' }, risk: 'high', timeout_sec: 600 });
    hub.sweep();

    const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, locale: 'zh-TW' });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(hub.base + '/ui/');
    await page.fill('#token', hub.adminToken);
    await page.click('#login button[type=submit]');
    await page.waitForSelector('text=睡著或離線的機器');
    const home = await page.textContent('#app');
    assert.match(home, /macbook-hc/);
    assert.match(home, /筆電/);
    assert.match(home, /42 分鐘/);
    assert.match(home, /waiting_node/);
    assert.match(home, /iOS 單元測試/);
    assert.match(home, /等待 macbook-hc（macbook-hc）：已 42 分鐘沒有回應/);
    assert.match(home, /new-mac/);
    assert.match(home, /git push origin relay\/x/);
    await page.waitForFunction(() => document.querySelector('#live').classList.contains('on'));
    if (shots) await page.screenshot({ path: path.join(shots, 'dashboard-home.png'), fullPage: true });

    await page.click('[data-approve="new-mac"]');
    await page.waitForSelector('text=沒有待核准的機器。');
    assert.equal((await hub.admin.get('/nodes/new-mac')).data.state, 'active');

    await page.fill('[data-note]', '只做編譯，不要推送');
    await page.click('[data-decide="deny"]');
    await page.waitForSelector('text=沒有待審核項目。');
    const ap = (await hub.admin.get('/approvals')).data.items[0];
    assert.equal(ap.state, 'deny');
    assert.equal(ap.note, '只做編譯，不要推送');

    await page.goto(hub.base + '/ui/#node-macbook-hc');
    await page.waitForSelector('#f-grace');
    await page.fill('#f-grace', '7200');
    await page.fill('#f-notes', '晚上帶回家，常闔蓋');
    await page.click('#meta button[type=submit]');
    await page.waitForSelector('text=meta_version 2');
    const n = (await hub.admin.get('/nodes/macbook-hc')).data;
    assert.equal(n.meta.presence.suspend_grace_sec, 7200);
    assert.equal(n.meta.notes, '晚上帶回家，常闔蓋');
    if (shots) await page.screenshot({ path: path.join(shots, 'dashboard-node.png'), fullPage: true });

    await page.goto(hub.base + '/ui/#enroll');
    await page.waitForSelector('#e-name');
    await page.fill('#e-name', '辦公室 Mac Studio');
    await page.fill('#e-roles', 'tester, ios-builder');
    await page.fill('#e-labels', 'xcode=16');
    await page.click('#en button[type=submit]');
    await page.waitForSelector('#the-code');
    assert.match(await page.textContent('#the-code'), /^ape_[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    assert.match(await page.textContent('#the-cmd'), /aipagerctl join --hub/);

    await page.goto(hub.base + `/ui/#task-${q.data.task_id}`);
    await page.waitForSelector('text=instructions');
    await page.goto(hub.base + '/ui/?debug=1#nodes');
    await page.waitForSelector('text=debug: raw JSON');
    const mobile = await browser.newPage({ viewport: { width: 400, height: 860 }, locale: 'zh-TW' });
    await mobile.goto(hub.base + '/ui/');
    await mobile.fill('#token', hub.adminToken);
    await mobile.click('#login button[type=submit]');
    await mobile.waitForSelector('text=卡住的任務');
    const overflow = await mobile.evaluate(() => document.documentElement.scrollWidth - innerWidth);
    assert.ok(overflow <= 0, 'no horizontal page scroll on phones: ' + overflow);
    if (shots) await mobile.screenshot({ path: path.join(shots, 'dashboard-phone.png'), fullPage: true });
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await hub.cleanup(); }
});
