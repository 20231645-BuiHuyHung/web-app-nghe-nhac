const fs = require('fs');
const path = require('path');
const initSqlJs = require('sql.js');

const email = process.argv[2]?.trim().toLowerCase();
const dbPath = path.join(__dirname, '..', 'data', 'music.sqlite');

if (!email) {
  console.error('Cách dùng: node scripts/promote-admin.js <email>');
  process.exit(1);
}

async function main() {
  if (!fs.existsSync(dbPath)) throw new Error('Chưa có database SQLite. Hãy chạy server ít nhất một lần trước.');
  const SQL = await initSqlJs({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
  const database = new SQL.Database(fs.readFileSync(dbPath));
  try {
    const statement = database.prepare('SELECT id, email FROM users WHERE email = ? COLLATE NOCASE');
    statement.bind([email]);
    const user = statement.step() ? statement.getAsObject() : null;
    statement.free();
    if (!user) throw new Error(`Không tìm thấy tài khoản ${email}. Hãy đăng ký tài khoản trước.`);

    const update = database.prepare("UPDATE users SET role = 'admin', status = 'active' WHERE id = ?");
    update.run([user.id]);
    update.free();
    const temporaryFile = `${dbPath}.tmp`;
    fs.writeFileSync(temporaryFile, Buffer.from(database.export()));
    fs.renameSync(temporaryFile, dbPath);
    console.log(`Đã cấp quyền admin cho ${user.email} trong SQLite.`);
  } finally {
    database.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
