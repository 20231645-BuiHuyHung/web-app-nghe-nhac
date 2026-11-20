const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');
const initSqlJs = require('sql.js');

const projectRoot = path.join(__dirname, '..');

async function findAvailablePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

function passwordCredentials(password) {
  const passwordSalt = crypto.randomBytes(16).toString('hex');
  return {
    passwordSalt,
    passwordHash: crypto.scryptSync(password, passwordSalt, 64).toString('hex'),
  };
}

function expectedExpiry(start, months) {
  const result = new Date(start);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

async function createFixture({
  includeRangeAudio = false,
  includeVipSongs = false,
  enableVnpay = false,
  vnpayQueryUrl,
} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'music-app-test-'));
  for (const directory of ['data', 'public', path.join('uploads', 'audio'), path.join('uploads', 'covers')]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  const adminPassword = 'test-admin-password-123';
  const userPassword = 'test-user-password-123';
  const legacyData = {
    users: [
      {
        id: 1, name: 'Test Admin', email: 'admin@example.test',
        ...passwordCredentials(adminPassword), role: 'admin', status: 'active',
      },
      {
        id: 2, name: 'Test User', email: 'user@example.test',
        ...passwordCredentials(userPassword), role: 'user', status: 'active',
      },
    ],
    artists: includeRangeAudio || includeVipSongs
      ? [{ id: 1, name: 'Range Test Artist', bio: '', avatar: '' }]
      : [],
    albums: [],
    songs: includeRangeAudio
      ? [{
        id: 1, title: 'Range Test Track', artistId: 1, albumId: null, genre: 'Test',
        duration: 30, audioUrl: '/uploads/audio/range-test.mp3', cover: '', plays: 0,
        userId: null, lyrics: '', isVip: 0,
      }]
      : includeVipSongs
        ? [
          {
            id: 1, title: 'VIP Test Track', artistId: 1, albumId: null, genre: 'Test',
            duration: 30, audioUrl: '/uploads/audio/vip-test.mp3', cover: '', plays: 0,
            userId: null, lyrics: '', isVip: 1,
          },
          {
            id: 2, title: 'Public Test Track', artistId: 1, albumId: null, genre: 'Test',
            duration: 30, audioUrl: '/uploads/audio/public-test.mp3', cover: '', plays: 0,
            userId: null, lyrics: '', isVip: 0,
          },
        ]
        : [],
    playlists: [], genres: [],
  };
  fs.writeFileSync(path.join(root, 'server.js'), fs.readFileSync(path.join(projectRoot, 'server.js')));
  fs.writeFileSync(path.join(root, 'data', 'db.json'), JSON.stringify(legacyData));
  if (includeRangeAudio) {
    fs.writeFileSync(path.join(root, 'uploads', 'audio', 'range-test.mp3'), Buffer.from('0123456789'));
  }

  const port = await findAvailablePort();
  const fixture = {
    root,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    adminPassword,
    userPassword,
    child: null,
  };
  await startFixtureServer(fixture, enableVnpay, vnpayQueryUrl);
  return fixture;
}

async function startFixtureServer(fixture, enableVnpay, vnpayQueryUrl) {
  const child = spawn(process.execPath, ['server.js'], {
    cwd: fixture.root,
    env: {
      ...process.env,
      NODE_PATH: path.join(projectRoot, 'node_modules'),
      PORT: String(fixture.port),
      NODE_ENV: 'test',
      APP_BASE_URL: enableVnpay ? 'https://music.example.test' : 'http://localhost:3000',
      VNPAY_TMN_CODE: enableVnpay ? 'TESTMERCHANT' : '',
      VNPAY_HASH_SECRET: enableVnpay ? 'test-vnpay-hash-secret' : '',
      ...(vnpayQueryUrl ? { VNPAY_QUERY_URL: vnpayQueryUrl } : {}),
      SMTP_HOST: '',
      SMTP_FROM: '',
      SMTP_USER: '',
      SMTP_PASS: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { logs += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { logs += chunk; });
  fixture.child = child;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Test server exited during startup:\n${logs}`);
    try {
      if ((await fetch(`${fixture.baseUrl}/api/songs`)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await delay(100);
  }
  if (!ready) {
    child.kill();
    throw new Error(`Test server did not become ready:\n${logs}`);
  }
}

async function stopServer(fixture) {
  if (fixture.child.exitCode === null) {
    fixture.child.kill();
    await Promise.race([once(fixture.child, 'exit'), delay(5000)]);
    if (fixture.child.exitCode === null) fixture.child.kill('SIGKILL');
  }
}

function createClient(baseUrl) {
  let cookie = '';
  return async function request(route, { method = 'GET', body } = {}) {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';', 1)[0];
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
}

function signVnpayParams(params, secret = 'test-vnpay-hash-secret') {
  const canonical = Object.keys(params)
    .filter((key) => key !== 'vnp_SecureHash' && key !== 'vnp_SecureHashType')
    .sort()
    .map((key) => `${key}=${encodeURIComponent(String(params[key])).replace(/%20/g, '+')}`)
    .join('&');
  return {
    ...params,
    vnp_SecureHash: crypto.createHmac('sha512', secret).update(canonical, 'utf8').digest('hex'),
  };
}

function signVnpayQueryResponse(params) {
  const data = [
    params.vnp_ResponseId,
    params.vnp_Command,
    params.vnp_ResponseCode,
    params.vnp_Message,
    params.vnp_TmnCode,
    params.vnp_TxnRef,
    params.vnp_Amount,
    params.vnp_BankCode,
    params.vnp_PayDate,
    params.vnp_TransactionNo,
    params.vnp_TransactionType,
    params.vnp_TransactionStatus,
    params.vnp_OrderInfo,
    params.vnp_PromotionCode,
    params.vnp_PromotionAmount,
  ].map((value) => value === undefined ? '' : String(value)).join('|');
  return {
    ...params,
    vnp_SecureHash: crypto.createHmac('sha512', 'test-vnpay-hash-secret').update(data).digest('hex'),
  };
}

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function queryString(params) {
  return new URLSearchParams(params).toString();
}

async function backdatePaymentExpiry(fixture, txnRef) {
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const database = new SQL.Database(fs.readFileSync(path.join(fixture.root, 'data', 'music.sqlite')));
  const expiresAt = new Date(Date.now() - 60_000).toISOString();
  database.run('UPDATE vnpay_payments SET expires_at = ? WHERE txn_ref = ?', [expiresAt, txnRef]);
  const bytes = Buffer.from(database.export());
  database.close();
  fs.writeFileSync(path.join(fixture.root, 'data', 'music.sqlite'), bytes);
}

async function backdatePremiumReview(fixture, requestId, monthsAgo) {
  const wasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
  const SQL = await initSqlJs({ locateFile: () => wasmPath });
  const database = new SQL.Database(fs.readFileSync(path.join(fixture.root, 'data', 'music.sqlite')));
  const reviewedAt = new Date();
  reviewedAt.setUTCMonth(reviewedAt.getUTCMonth() - monthsAgo);
  database.run('UPDATE premium_requests SET reviewed_at = ? WHERE id = ?', [reviewedAt.toISOString(), requestId]);
  const bytes = Buffer.from(database.export());
  database.close();
  fs.writeFileSync(path.join(fixture.root, 'data', 'music.sqlite'), bytes);
  return reviewedAt;
}

async function solveCaptcha(client) {
  const { body: challenge } = await client('/api/auth/password-reset-captcha');
  const [, left, operator, right] = challenge.question.match(/^(\d+) ([+−]) (\d+) = \?$/);
  const answer = String(operator === '+'
    ? Number(left) + Number(right)
    : Math.abs(Number(left) - Number(right)));
  return { challengeId: challenge.challengeId, answer };
}

test('audio streaming supports valid byte ranges and rejects unsatisfiable ranges', async (t) => {
  const fixture = await createFixture({ includeRangeAudio: true });
  t.after(async () => {
    await stopServer(fixture);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  let response = await fetch(`${fixture.baseUrl}/api/stream/1`, {
    headers: { Range: 'bytes=3-6' },
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 3-6/10');
  assert.equal(response.headers.get('content-length'), '4');
  assert.equal(await response.text(), '3456');

  response = await fetch(`${fixture.baseUrl}/api/stream/1`, {
    headers: { Range: 'bytes=-3' },
  });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), 'bytes 7-9/10');
  assert.equal(await response.text(), '789');

  response = await fetch(`${fixture.baseUrl}/api/stream/1`, {
    headers: { Range: 'bytes=10-' },
  });
  assert.equal(response.status, 416);
  assert.equal(response.headers.get('content-range'), 'bytes */10');

  response = await fetch(`${fixture.baseUrl}/api/stream/1`, {
    headers: { Range: 'bytes=0-1,4-5' },
  });
  assert.equal(response.status, 416, 'multiple byte ranges are not supported by this endpoint');
});

test('VIP library only returns VIP songs to accounts with an active plan', async (t) => {
  const fixture = await createFixture({ includeVipSongs: true });
  t.after(async () => {
    await stopServer(fixture);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const anonymous = createClient(fixture.baseUrl);
  const user = createClient(fixture.baseUrl);
  const admin = createClient(fixture.baseUrl);

  assert.equal((await anonymous('/api/premium/songs')).status, 401);
  assert.equal((await user('/api/auth/login', {
    method: 'POST', body: { login: 'user@example.test', password: fixture.userPassword },
  })).status, 200);
  assert.equal((await user('/api/premium/songs')).status, 403);
  assert.equal((await admin('/api/auth/login', {
    method: 'POST', body: { login: 'admin@example.test', password: fixture.adminPassword },
  })).status, 200);
  assert.equal((await admin('/api/admin/users/2/premium', {
    method: 'POST', body: { action: 'grant' },
  })).status, 200);

  const library = await user('/api/premium/songs');
  assert.equal(library.status, 200);
  assert.deepEqual(library.body.map((song) => song.id), [1]);
  assert.equal(library.body[0].isVip, true);
  assert.equal((await admin('/api/admin/users/2/premium', {
    method: 'POST', body: { action: 'revoke' },
  })).status, 200);
  assert.equal((await user('/api/premium/songs')).status, 403);
});

test('authentication endpoints use a short rate-limit window instead of a 15-minute lockout', async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    await stopServer(fixture);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  const client = createClient(fixture.baseUrl);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assert.equal((await client('/api/auth/login', {
      method: 'POST', body: {},
    })).status, 400);
  }
  const limited = await client('/api/auth/login', { method: 'POST', body: {} });
  assert.equal(limited.status, 429);
  assert.match(limited.body.error, /đợi 1 phút/);
  assert.doesNotMatch(limited.body.error, /15 phút/);
});

test('listening history is account-only, filterable, and supports curated trend songs', async (t) => {
  const fixture = await createFixture({ includeRangeAudio: true });
  t.after(async () => {
    await stopServer(fixture);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const anonymous = createClient(fixture.baseUrl);
  const user = createClient(fixture.baseUrl);
  const admin = createClient(fixture.baseUrl);
  assert.equal((await user('/api/auth/login', {
    method: 'POST', body: { login: 'user@example.test', password: fixture.userPassword },
  })).status, 200);
  assert.equal((await admin('/api/auth/login', {
    method: 'POST', body: { login: 'admin@example.test', password: fixture.adminPassword },
  })).status, 200);

  assert.equal((await anonymous('/api/songs/1/play', { method: 'POST' })).status, 200);
  assert.equal((await user('/api/songs/1/play', { method: 'POST' })).status, 200);
  assert.equal((await user('/api/songs/1/play', { method: 'POST' })).status, 200);
  assert.equal((await admin('/api/songs/1/play', { method: 'POST' })).status, 200);
  assert.equal((await anonymous('/api/admin/listening-analytics')).status, 401);
  assert.equal((await user('/api/admin/listening-analytics')).status, 403);

  let response = await admin('/api/admin/listening-analytics?period=week');
  assert.equal(response.status, 200);
  assert.equal(response.body.retention, 'indefinite');
  assert.equal(response.body.summary.listenCount, 3,
    'anonymous plays increase the legacy counter but are not added to identifiable history');
  assert.equal(response.body.summary.uniqueListeners, 2);
  assert.equal(response.body.chart.length, 7);
  assert.equal(response.body.chart.reduce((sum, item) => sum + item.listenCount, 0), 3);
  assert.equal(response.body.topSongs[0].listenCount, 3);
  assert.equal(response.body.recent.length, 3);
  assert.equal(response.body.recent[0].userEmail, 'admin@example.test');
  assert.equal(response.body.recent[0].songTitle, 'Range Test Track');

  response = await admin('/api/admin/listening-analytics?period=day');
  assert.equal(response.body.chart.length, 24);
  assert.equal(response.body.summary.listenCount, 3);
  assert.equal((await admin('/api/admin/listening-analytics?period=invalid')).status, 400);

  response = await admin('/api/admin/overview');
  assert.equal(response.body.userCount, 2);
  assert.equal(response.body.genreStats[0].genre, 'Test');
  assert.equal(response.body.topSongs[0].plays, 4);
  assert.equal(response.body.topSongs[0].isTrending, false);

  response = await admin('/api/admin/songs/1/trending', {
    method: 'PATCH', body: { isTrending: true },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.isTrending, true);
  assert.equal((await user('/api/songs')).body[0].isTrending, true,
    'curated trend state must be visible to the public app');
  assert.equal((await admin('/api/admin/songs/1/trending', {
    method: 'PATCH', body: { isTrending: false },
  })).body.isTrending, false);
});

test('VIP approval and support conversations enforce roles and persist', async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    await stopServer(fixture);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const user = createClient(fixture.baseUrl);
  const admin = createClient(fixture.baseUrl);

  assert.equal((await user('/api/auth/login', {
    method: 'POST', body: { login: 'user@example.test', password: fixture.userPassword },
  })).status, 200);
  assert.equal((await admin('/api/auth/login', {
    method: 'POST', body: { login: 'admin@example.test', password: fixture.adminPassword },
  })).status, 200);
  assert.equal((await user('/api/admin/premium-requests')).status, 403);
  assert.equal((await user('/api/admin/revenue')).status, 403);

  let response = await user('/api/premium/requests', { method: 'POST', body: { plan: 'month' } });
  assert.equal(response.status, 201);
  const requestId = response.body.id;
  let userRequests = await user('/api/premium/requests');
  assert.equal(userRequests.body[0].status, 'pending');
  const pendingRevenue = await admin('/api/admin/revenue');
  assert.equal(pendingRevenue.body.totals.day, 0, 'pending VIP requests must not count as revenue');
  const submittedAt = Date.now();
  response = await admin(`/api/admin/premium-requests/${requestId}/review`, {
    method: 'POST', body: { action: 'approve' },
  });
  assert.equal(response.status, 200);
  userRequests = await user('/api/premium/requests');
  assert.equal(userRequests.body[0].status, 'approved',
    'the user-facing request endpoint should expose the updated approval status');
  const revenue = await admin('/api/admin/revenue');
  assert.equal(revenue.status, 200);
  assert.equal(revenue.body.totals.day, 49000);
  assert.equal(revenue.body.totals.week, 49000);
  assert.equal(revenue.body.totals.month, 49000);
  assert.equal(revenue.body.totals.halfYear, 49000);
  assert.equal(revenue.body.totals.year, 49000);
  assert.equal(revenue.body.charts.week.length, 7);
  assert.equal(revenue.body.charts.all.reduce((sum, month) => sum + month.amount, 0), revenue.body.totals.all);
  assert.equal(revenue.body.totals.all, 49000);
  assert.equal(revenue.body.sales.length, 1);
  assert.equal(revenue.body.sales[0].requestId, requestId);
  assert.equal(revenue.body.sales[0].userName, 'Test User');
  assert.equal(revenue.body.sales[0].userEmail, 'user@example.test');
  assert.equal(revenue.body.sales[0].plan, 'month');
  assert.equal(revenue.body.sales[0].amount, 49000);
  assert.ok(revenue.body.sales[0].reviewedAt);
  const account = (await user('/api/auth/me')).body.user;
  assert.equal(account.isPremium, true);
  assert.ok(Math.abs(Date.parse(account.premiumExpiresAt) - expectedExpiry(submittedAt, 1).getTime()) < 5000);

  response = await user('/api/support/conversations', { method: 'POST' });
  assert.equal(response.status, 201);
  const conversationId = response.body.conversation.id;
  assert.equal((await user(`/api/support/conversations/${conversationId}/messages`, {
    method: 'POST', body: { message: 'Tôi không phát được bài hát.' },
  })).status, 201);
  response = await admin('/api/admin/support/conversations');
  assert.equal(response.status, 200);
  assert.equal(response.body[0].lastMessage, 'Tôi không phát được bài hát.');
  response = await admin(`/api/admin/support/conversations/${conversationId}/messages`, {
    method: 'POST', body: { message: 'Bạn hãy thử tải lại trang nhé.' },
  });
  assert.equal(response.status, 201);
  response = await user(`/api/support/conversations/${conversationId}/messages`);
  assert.equal(response.body.messages[1].body, 'Bạn hãy thử tải lại trang nhé.');
});

test('VNPay Sandbox verifies orders, processes IPN once, and records failed payments', async (t) => {
  const fixture = await createFixture({ enableVnpay: true });
  t.after(async () => {
    await stopServer(fixture);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const user = createClient(fixture.baseUrl);
  const otherUser = createClient(fixture.baseUrl);
  const admin = createClient(fixture.baseUrl);

  assert.equal((await user('/api/auth/login', {
    method: 'POST', body: { login: 'user@example.test', password: fixture.userPassword },
  })).status, 200);
  assert.equal((await otherUser('/api/auth/login', {
    method: 'POST', body: { login: 'admin@example.test', password: fixture.adminPassword },
  })).status, 200);
  assert.equal((await admin('/api/auth/login', {
    method: 'POST', body: { login: 'admin@example.test', password: fixture.adminPassword },
  })).status, 200);
  assert.equal((await user('/api/payments/vnpay/config')).body.enabled, true);

  let response = await user('/api/premium/checkout', {
    method: 'POST', body: { plan: 'month' },
  });
  assert.equal(response.status, 201);
  const { txnRef, paymentUrl } = response.body;
  const paymentUrlParams = Object.fromEntries(new URL(paymentUrl).searchParams.entries());
  const { vnp_SecureHash, ...unsignedUrlParams } = paymentUrlParams;
  assert.equal(vnp_SecureHash, signVnpayParams(unsignedUrlParams).vnp_SecureHash,
    'checkout must return a correctly signed VNPay URL');
  assert.equal(paymentUrlParams.vnp_Amount, '4900000');
  assert.equal(paymentUrlParams.vnp_BankCode, 'NCB', 'Sandbox checkout should select the NCB test-card flow');
  assert.equal(new URL(paymentUrl).hostname, 'sandbox.vnpayment.vn');
  assert.equal((await otherUser(`/api/premium/payments/${txnRef}`)).status, 404,
    'users must not be able to inspect another account’s payment');
  assert.equal((await user('/api/admin/revenue')).status, 403);
  let adminRequests = (await admin('/api/admin/premium-requests')).body;
  assert.equal(adminRequests[0].payment.status, 'pending');
  assert.equal(adminRequests[0].payment.txnRef, txnRef);
  const returnParams = signVnpayParams({
    vnp_TmnCode: 'TESTMERCHANT',
    vnp_TxnRef: txnRef,
    vnp_Amount: '4900000',
    vnp_ResponseCode: '00',
    vnp_TransactionStatus: '00',
  });
  let returnResponse = await fetch(`${fixture.baseUrl}/api/payments/vnpay/return?${queryString(returnParams)}`, {
    redirect: 'manual',
  });
  assert.equal(returnResponse.status, 303);
  assert.equal(returnResponse.headers.get('location'),
    `https://music.example.test/#/premium/payment/${txnRef}`);
  const invalidReturn = { ...returnParams, vnp_SecureHash: '0'.repeat(128) };
  returnResponse = await fetch(`${fixture.baseUrl}/api/payments/vnpay/return?${queryString(invalidReturn)}`, {
    redirect: 'manual',
  });
  assert.equal(returnResponse.status, 400, 'unsigned browser returns must not be trusted');

  const signedIpn = signVnpayParams({
    vnp_TmnCode: 'TESTMERCHANT',
    vnp_TxnRef: txnRef,
    vnp_Amount: '4900000',
    vnp_ResponseCode: '00',
    vnp_TransactionStatus: '00',
    vnp_TransactionNo: '987654321',
    vnp_BankCode: 'NCB',
    vnp_CardType: 'ATM',
    vnp_PayDate: '20260101120000',
  });
  response = await user(`/api/payments/vnpay/ipn?${queryString({
    ...signedIpn,
    vnp_SecureHash: '0'.repeat(128),
  })}`);
  assert.equal(response.body.RspCode, '97', 'invalid signatures must not update payments');

  const wrongAmountIpn = signVnpayParams({
    ...signedIpn,
    vnp_Amount: '1',
  });
  response = await user(`/api/payments/vnpay/ipn?${queryString(wrongAmountIpn)}`);
  assert.equal(response.body.RspCode, '04', 'the signed amount must match the order');

  response = await user(`/api/payments/vnpay/ipn?${queryString(signedIpn)}`);
  assert.equal(response.body.RspCode, '00');
  const payment = (await user(`/api/premium/payments/${txnRef}`)).body;
  assert.equal(payment.status, 'paid');
  assert.equal(payment.vipActivated, 1);
  assert.equal(payment.transactionNo, '987654321');
  assert.equal(payment.bankCode, 'NCB');
  adminRequests = (await admin('/api/admin/premium-requests')).body;
  assert.equal(adminRequests[0].payment.status, 'paid');
  const expiryAfterPayment = (await user('/api/auth/me')).body.user.premiumExpiresAt;

  response = await user(`/api/payments/vnpay/ipn?${queryString(signedIpn)}`);
  assert.equal(response.body.RspCode, '02', 'duplicate IPNs must be acknowledged without reactivating VIP');
  assert.equal((await user('/api/auth/me')).body.user.premiumExpiresAt, expiryAfterPayment);
  const revenue = (await admin('/api/admin/revenue')).body;
  assert.equal(revenue.sales.length, 1);
  assert.equal(revenue.sales[0].amount, 49000);
  assert.equal(revenue.payments.length, 1);
  assert.equal(revenue.payments[0].txnRef, txnRef);
  assert.equal(revenue.payments[0].vipActivated, true);

  response = await user('/api/premium/checkout', {
    method: 'POST', body: { plan: 'halfYear' },
  });
  assert.equal(response.status, 201, 'a completed payment must not block a later order');
  const failedTxnRef = response.body.txnRef;
  const failedIpn = signVnpayParams({
    vnp_TmnCode: 'TESTMERCHANT',
    vnp_TxnRef: failedTxnRef,
    vnp_Amount: '26900000',
    vnp_ResponseCode: '24',
    vnp_TransactionStatus: '02',
  });
  response = await user(`/api/payments/vnpay/ipn?${queryString(failedIpn)}`);
  assert.equal(response.body.RspCode, '00');
  assert.equal((await user(`/api/premium/payments/${failedTxnRef}`)).body.status, 'failed');
  const requests = (await user('/api/premium/requests')).body;
  assert.equal(requests.find((request) => request.payment?.txnRef === failedTxnRef).status, 'rejected');
  assert.equal((await admin('/api/admin/premium-requests')).body[0].payment.status, 'failed');
  const updatedRevenue = (await admin('/api/admin/revenue')).body;
  assert.equal(updatedRevenue.payments.length, 2,
    'the admin dashboard data must include both successful and failed orders');
  assert.equal(updatedRevenue.totals.day, 49000, 'failed payments must not count as revenue');
  assert.equal((await user('/api/premium/checkout', {
    method: 'POST', body: { plan: 'year' },
  })).status, 201, 'a failed payment must release the user for another checkout');
});

test('revenue charts and filters include the full approved-payment history', async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    await stopServer(fixture);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  const user = createClient(fixture.baseUrl);
  const admin = createClient(fixture.baseUrl);
  assert.equal((await user('/api/auth/login', {
    method: 'POST', body: { login: 'user@example.test', password: fixture.userPassword },
  })).status, 200);
  assert.equal((await admin('/api/auth/login', {
    method: 'POST', body: { login: 'admin@example.test', password: fixture.adminPassword },
  })).status, 200);

  const request = await user('/api/premium/requests', {
    method: 'POST', body: { plan: 'month' },
  });
  assert.equal(request.status, 201);
  assert.equal((await admin(`/api/admin/premium-requests/${request.body.id}/review`, {
    method: 'POST', body: { action: 'approve' },
  })).status, 200);

  await stopServer(fixture);
  const historicalReview = await backdatePremiumReview(fixture, request.body.id, 3);
  await startFixtureServer(fixture, false);

  const resumedAdmin = createClient(fixture.baseUrl);
  assert.equal((await resumedAdmin('/api/auth/login', {
    method: 'POST', body: { login: 'admin@example.test', password: fixture.adminPassword },
  })).status, 200);
  const revenue = await resumedAdmin('/api/admin/revenue');
  assert.equal(revenue.status, 200);
  assert.equal(revenue.body.totals.day, 0);
  assert.equal(revenue.body.totals.month, 0);
  assert.equal(revenue.body.totals.halfYear, 49000);
  assert.equal(revenue.body.totals.all, 49000);
  assert.equal(revenue.body.charts.month.reduce((sum, item) => sum + item.amount, 0), 0);
  assert.equal(revenue.body.charts.halfYear.reduce((sum, item) => sum + item.amount, 0), 49000);
  assert.equal(revenue.body.charts.all.reduce((sum, item) => sum + item.amount, 0), 49000);
  assert.equal(Date.parse(revenue.body.sales[0].reviewedAt), historicalReview.getTime());
});

test('checking a pending VNPay payment queries and verifies the transaction before activating VIP', async (t) => {
  let tamperResponse = true;
  let queryResponseCode = '00';
  const queryRequests = [];
  const queryServer = http.createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const query = JSON.parse(body);
      queryRequests.push(query);
      const queryResponse = signVnpayQueryResponse({
        vnp_ResponseId: `response-${queryRequests.length}`,
        vnp_Command: 'querydr',
        vnp_ResponseCode: queryResponseCode,
        vnp_Message: queryResponseCode === '00' ? 'Confirm Success' : 'Transaction not found',
        vnp_TmnCode: 'TESTMERCHANT',
        vnp_TxnRef: query.vnp_TxnRef,
        vnp_Amount: queryResponseCode === '00' ? '26900000' : '',
        vnp_BankCode: queryResponseCode === '00' ? 'NCB' : '',
        vnp_PayDate: queryResponseCode === '00' ? '20261118104851' : '',
        vnp_TransactionNo: queryResponseCode === '00' ? '15740948' : '',
        vnp_TransactionType: queryResponseCode === '00' ? '01' : '',
        vnp_TransactionStatus: queryResponseCode === '00' ? '00' : '',
        vnp_OrderInfo: query.vnp_OrderInfo,
        vnp_PromotionCode: '',
        vnp_PromotionAmount: '0',
      });
      if (tamperResponse) queryResponse.vnp_SecureHash = '0'.repeat(128);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(queryResponse));
    });
  });
  const queryPort = await listen(queryServer);
  t.after(() => new Promise((resolve, reject) => {
    queryServer.close((error) => error ? reject(error) : resolve());
  }));

  const fixture = await createFixture({
    enableVnpay: true,
    vnpayQueryUrl: `http://127.0.0.1:${queryPort}/transaction`,
  });
  t.after(async () => {
    await stopServer(fixture);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  const user = createClient(fixture.baseUrl);
  assert.equal((await user('/api/auth/login', {
    method: 'POST', body: { login: 'user@example.test', password: fixture.userPassword },
  })).status, 200);
  const checkout = await user('/api/premium/checkout', {
    method: 'POST', body: { plan: 'halfYear' },
  });
  assert.equal(checkout.status, 201);

  let response = await user(`/api/premium/payments/${checkout.body.txnRef}/check`, { method: 'POST' });
  assert.equal(response.status, 502, 'an invalid VNPay query signature must be rejected');
  assert.equal((await user(`/api/premium/payments/${checkout.body.txnRef}`)).body.status, 'pending');
  assert.equal((await user('/api/auth/me')).body.user.isPremium, false);

  const query = queryRequests[0];
  const requestSignatureData = [
    query.vnp_RequestId,
    query.vnp_Version,
    query.vnp_Command,
    query.vnp_TmnCode,
    query.vnp_TxnRef,
    query.vnp_TransactionDate,
    query.vnp_CreateDate,
    query.vnp_IpAddr,
    query.vnp_OrderInfo,
  ].join('|');
  assert.equal(query.vnp_Command, 'querydr');
  assert.equal(query.vnp_SecureHash,
    crypto.createHmac('sha512', 'test-vnpay-hash-secret').update(requestSignatureData).digest('hex'));

  tamperResponse = false;
  queryResponseCode = '91';
  response = await user(`/api/premium/payments/${checkout.body.txnRef}/check`, { method: 'POST' });
  assert.equal(response.status, 502);
  assert.match(response.body.error, /chưa tìm thấy giao dịch/i);
  assert.equal((await user(`/api/premium/payments/${checkout.body.txnRef}`)).body.status, 'pending');
  assert.equal((await user('/api/auth/me')).body.user.isPremium, false);

  queryResponseCode = '00';
  response = await user(`/api/premium/payments/${checkout.body.txnRef}/check`, { method: 'POST' });
  assert.equal(response.status, 200);
  assert.equal(response.body.status, 'paid');
  assert.equal(response.body.vipActivated, 1);
  assert.equal(response.body.transactionNo, '15740948');
  assert.equal((await user('/api/auth/me')).body.user.isPremium, true);
});

test('expired VNPay orders release checkout and a late verified success IPN is reconciled', async (t) => {
  const fixture = await createFixture({ enableVnpay: true });
  t.after(async () => {
    await stopServer(fixture);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const user = createClient(fixture.baseUrl);
  assert.equal((await user('/api/auth/login', {
    method: 'POST', body: { login: 'user@example.test', password: fixture.userPassword },
  })).status, 200);

  const firstOrder = await user('/api/premium/checkout', {
    method: 'POST', body: { plan: 'month' },
  });
  assert.equal(firstOrder.status, 201);

  await stopServer(fixture);
  await backdatePaymentExpiry(fixture, firstOrder.body.txnRef);
  await startFixtureServer(fixture, true);

  const resumedUser = createClient(fixture.baseUrl);
  assert.equal((await resumedUser('/api/auth/login', {
    method: 'POST', body: { login: 'user@example.test', password: fixture.userPassword },
  })).status, 200);
  const requests = await resumedUser('/api/premium/requests');
  assert.equal(requests.body[0].status, 'rejected');
  assert.equal(requests.body[0].payment.status, 'expired');

  const retryOrder = await resumedUser('/api/premium/checkout', {
    method: 'POST', body: { plan: 'year' },
  });
  assert.equal(retryOrder.status, 201, 'an abandoned expired order must not block a new checkout');

  const lateSuccess = signVnpayParams({
    vnp_TmnCode: 'TESTMERCHANT',
    vnp_TxnRef: firstOrder.body.txnRef,
    vnp_Amount: '4900000',
    vnp_ResponseCode: '00',
    vnp_TransactionStatus: '00',
    vnp_TransactionNo: '123456789',
  });
  const ipn = await resumedUser(`/api/payments/vnpay/ipn?${queryString(lateSuccess)}`);
  assert.equal(ipn.body.RspCode, '00');
  const settledPayment = await resumedUser(`/api/premium/payments/${firstOrder.body.txnRef}`);
  assert.equal(settledPayment.body.status, 'paid');
  assert.equal(settledPayment.body.vipActivated, 1);
  assert.equal((await resumedUser('/api/auth/me')).body.user.isPremium, true);
});

test('an authenticated user can change their password using the current password', async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    await stopServer(fixture);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const anonymous = createClient(fixture.baseUrl);
  const user = createClient(fixture.baseUrl);
  const anotherSession = createClient(fixture.baseUrl);
  const admin = createClient(fixture.baseUrl);

  assert.equal((await anonymous('/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: fixture.userPassword, newPassword: 'new-user-password-456' },
  })).status, 401);
  assert.equal((await user('/api/auth/login', {
    method: 'POST', body: { login: 'user@example.test', password: fixture.userPassword },
  })).status, 200);
  assert.equal((await anotherSession('/api/auth/login', {
    method: 'POST', body: { login: 'user@example.test', password: fixture.userPassword },
  })).status, 200);
  assert.equal((await admin('/api/auth/login', {
    method: 'POST', body: { login: 'admin@example.test', password: fixture.adminPassword },
  })).status, 200);

  const challenge = await solveCaptcha(anonymous);
  assert.equal((await anonymous('/api/auth/password-reset-requests', {
    method: 'POST', body: { email: 'user@example.test', ...challenge },
  })).status, 202);
  const requests = await admin('/api/admin/password-reset-requests');
  const approved = await admin(`/api/admin/password-reset-requests/${requests.body[0].id}/review`, {
    method: 'POST', body: { action: 'approve' },
  });
  assert.equal(approved.status, 200);

  let response = await user('/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: 'wrong-password', newPassword: 'new-user-password-456' },
  });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /không đúng/);
  response = await user('/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: fixture.userPassword, newPassword: 'short' },
  });
  assert.equal(response.status, 400);
  response = await user('/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: fixture.userPassword, newPassword: fixture.userPassword },
  });
  assert.equal(response.status, 400);

  const newPassword = 'new-user-password-456';
  response = await user('/api/auth/change-password', {
    method: 'POST',
    body: { currentPassword: fixture.userPassword, newPassword },
  });
  assert.equal(response.status, 200);
  assert.equal((await user('/api/auth/me')).body.user.email, 'user@example.test',
    'the session that changed the password should remain signed in');
  assert.equal((await anotherSession('/api/auth/me')).body.user, null,
    'other sessions should be invalidated');
  assert.equal((await anonymous('/api/auth/login', {
    method: 'POST', body: { login: 'user@example.test', password: fixture.userPassword },
  })).status, 401);
  assert.equal((await anonymous('/api/auth/login', {
    method: 'POST', body: { login: 'user@example.test', password: newPassword },
  })).status, 200);
  assert.equal((await anonymous('/api/auth/reset-password', {
    method: 'POST',
    body: { token: approved.body.token, password: 'reset-link-password-789' },
  })).status, 400, 'changing the password should invalidate outstanding reset links');
});

test('password recovery requires CAPTCHA and Admin approval before allowing a reset', async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    await stopServer(fixture);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const anonymous = createClient(fixture.baseUrl);
  const user = createClient(fixture.baseUrl);
  const admin = createClient(fixture.baseUrl);

  assert.equal((await user('/api/auth/login', {
    method: 'POST', body: { email: 'user@example.test', password: fixture.userPassword },
  })).status, 200);
  assert.equal((await admin('/api/auth/login', {
    method: 'POST', body: { email: 'admin@example.test', password: fixture.adminPassword },
  })).status, 200);
  assert.equal((await user('/api/admin/password-reset-requests')).status, 403);

  const challenge = await solveCaptcha(anonymous);
  assert.equal((await anonymous('/api/auth/password-reset-requests', {
    method: 'POST',
    body: { email: 'user@example.test', ...challenge, answer: '999' },
  })).status, 400);

  const validChallenge = await solveCaptcha(anonymous);
  const submitted = await anonymous('/api/auth/password-reset-requests', {
    method: 'POST',
    body: { email: 'user@example.test', ...validChallenge },
  });
  assert.equal(submitted.status, 202);
  assert.equal((await anonymous('/api/auth/password-reset-requests', {
    method: 'POST',
    body: { email: 'user@example.test', ...validChallenge },
  })).status, 400, 'CAPTCHA challenge should be single-use');
  const duplicateChallenge = await solveCaptcha(anonymous);
  assert.equal((await anonymous('/api/auth/password-reset-requests', {
    method: 'POST',
    body: { email: 'user@example.test', ...duplicateChallenge },
  })).status, 202);
  const unknownChallenge = await solveCaptcha(anonymous);
  const unknown = await anonymous('/api/auth/password-reset-requests', {
    method: 'POST',
    body: { email: 'unknown@example.test', ...unknownChallenge },
  });
  assert.equal(unknown.status, 202);
  assert.equal(unknown.body.message, submitted.body.message, 'response should not reveal account existence');

  let requests = await admin('/api/admin/password-reset-requests');
  assert.equal(requests.status, 200);
  assert.equal(requests.body.length, 1, 'only the registered account should create a request');
  assert.equal(requests.body[0].status, 'pending');
  const requestId = requests.body[0].id;
  const approved = await admin(`/api/admin/password-reset-requests/${requestId}/review`, {
    method: 'POST', body: { action: 'approve' },
  });
  assert.equal(approved.status, 200);
  assert.equal(approved.body.request.status, 'approved');
  assert.equal(approved.body.deliveryMethod, 'admin');
  assert.equal(typeof approved.body.token, 'string');
  requests = await admin('/api/admin/password-reset-requests');
  assert.equal(requests.body[0].status, 'approved', 'Admin list should visibly reflect approval');
  assert.equal((await admin(`/api/admin/password-reset-requests/${requestId}/review`, {
    method: 'POST', body: { action: 'approve' },
  })).status, 409, 'an approval link must not be issued twice');

  const newPassword = 'approved-reset-password-123';
  assert.equal((await anonymous('/api/auth/reset-password', {
    method: 'POST', body: { token: approved.body.token, password: newPassword },
  })).status, 200);
  assert.equal((await anonymous('/api/auth/reset-password', {
    method: 'POST', body: { token: approved.body.token, password: 'another-new-password-456' },
  })).status, 400, 'reset link should be single-use');
  assert.equal((await user('/api/auth/me')).body.user, null, 'reset should invalidate existing sessions');
  assert.equal((await anonymous('/api/auth/login', {
    method: 'POST', body: { email: 'user@example.test', password: fixture.userPassword },
  })).status, 401);
  assert.equal((await anonymous('/api/auth/login', {
    method: 'POST', body: { email: 'user@example.test', password: newPassword },
  })).status, 200);
});
