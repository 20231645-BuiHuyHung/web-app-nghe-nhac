const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { test } = require('node:test');

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

async function createFixture({ includeRangeAudio = false } = {}) {
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
    artists: includeRangeAudio ? [{ id: 1, name: 'Range Test Artist', bio: '', avatar: '' }] : [],
    albums: [],
    songs: includeRangeAudio ? [{
      id: 1, title: 'Range Test Track', artistId: 1, albumId: null, genre: 'Test',
      duration: 30, audioUrl: '/uploads/audio/range-test.mp3', cover: '', plays: 0,
      userId: null, lyrics: '', isVip: 0,
    }] : [],
    playlists: [], genres: [],
  };
  fs.writeFileSync(path.join(root, 'server.js'), fs.readFileSync(path.join(projectRoot, 'server.js')));
  fs.writeFileSync(path.join(root, 'data', 'db.json'), JSON.stringify(legacyData));
  if (includeRangeAudio) {
    fs.writeFileSync(path.join(root, 'uploads', 'audio', 'range-test.mp3'), Buffer.from('0123456789'));
  }

  const port = await findAvailablePort();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: {
      ...process.env,
      NODE_PATH: path.join(projectRoot, 'node_modules'),
      PORT: String(port),
      NODE_ENV: 'test',
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
  const baseUrl = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Test server exited during startup:\n${logs}`);
    try {
      if ((await fetch(`${baseUrl}/api/songs`)).ok) {
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
  return { root, baseUrl, adminPassword, userPassword, child };
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

test('VIP approval and support conversations enforce roles and persist', async (t) => {
  const fixture = await createFixture();
  t.after(async () => {
    await stopServer(fixture);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
  const user = createClient(fixture.baseUrl);
  const admin = createClient(fixture.baseUrl);

  assert.equal((await user('/api/auth/login', {
    method: 'POST', body: { email: 'user@example.test', password: fixture.userPassword },
  })).status, 200);
  assert.equal((await admin('/api/auth/login', {
    method: 'POST', body: { email: 'admin@example.test', password: fixture.adminPassword },
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
  assert.equal(revenue.body.chart.length, 14);
  assert.equal(revenue.body.chart.reduce((sum, day) => sum + day.amount, 0), 49000);
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
    method: 'POST', body: { email: 'user@example.test', password: fixture.userPassword },
  })).status, 200);
  assert.equal((await anotherSession('/api/auth/login', {
    method: 'POST', body: { email: 'user@example.test', password: fixture.userPassword },
  })).status, 200);
  assert.equal((await admin('/api/auth/login', {
    method: 'POST', body: { email: 'admin@example.test', password: fixture.adminPassword },
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
    method: 'POST', body: { email: 'user@example.test', password: fixture.userPassword },
  })).status, 401);
  assert.equal((await anonymous('/api/auth/login', {
    method: 'POST', body: { email: 'user@example.test', password: newPassword },
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
