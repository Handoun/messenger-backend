const { Pool } = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: parseInt(process.env.DB_PORT || '5432'),
  user: process.env.DB_USER || 'cbef',
  password: process.env.DB_PASSWORD || 'cbef12345',
  database: process.env.DB_NAME || 'cbef',
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

const initDb = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        avatar TEXT,
        bio TEXT DEFAULT '',
        is_admin BOOLEAN DEFAULT false,
        banned BOOLEAN DEFAULT false,
        ban_reason TEXT,
        ban_until TIMESTAMP,
        subscription_until TIMESTAMP,
        premium_only_messages BOOLEAN DEFAULT false,
        is_premium BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        user_id INTEGER NOT NULL REFERENCES users(id),
        contact_id INTEGER NOT NULL REFERENCES users(id),
        PRIMARY KEY (user_id, contact_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        sender_id INTEGER NOT NULL REFERENCES users(id),
        receiver_id INTEGER,
        group_id INTEGER,
        channel_id INTEGER,
        text TEXT,
        image TEXT,
        audio TEXT,
        status VARCHAR(20) DEFAULT 'sent',
        expires_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS friend_requests (
        id SERIAL PRIMARY KEY,
        from_id INTEGER NOT NULL REFERENCES users(id),
        to_id INTEGER NOT NULL REFERENCES users(id),
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS group_chats (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        creator_id INTEGER NOT NULL REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS group_members (
        group_id INTEGER NOT NULL REFERENCES group_chats(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (group_id, user_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS channels (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        creator_id INTEGER NOT NULL REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        subscribers_count INTEGER DEFAULT 0,
        is_premium BOOLEAN DEFAULT false
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS channel_subscribers (
        channel_id INTEGER NOT NULL REFERENCES channels(id),
        user_id INTEGER NOT NULL REFERENCES users(id),
        PRIMARY KEY (channel_id, user_id)
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS channel_messages (
        id SERIAL PRIMARY KEY,
        channel_id INTEGER NOT NULL REFERENCES channels(id),
        sender_id INTEGER NOT NULL REFERENCES users(id),
        text TEXT,
        image TEXT,
        audio TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS reports (
        id SERIAL PRIMARY KEY,
        reporter_id INTEGER REFERENCES users(id),
        reported_id INTEGER REFERENCES users(id),
        reason TEXT,
        message_id INTEGER,
        channel_id INTEGER,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        device TEXT,
        ip TEXT,
        token TEXT UNIQUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Migrations for existing tables
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT DEFAULT ''`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_reason TEXT`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ban_until TIMESTAMP`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS subscription_until TIMESTAMP`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS premium_only_messages BOOLEAN DEFAULT false`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_premium BOOLEAN DEFAULT false`);

    console.log('✅ Все таблицы готовы');
  } catch (err) {
    console.error('❌ Ошибка инициализации БД:', err.message);
  }
};

initDb();

module.exports = { pool };
