const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const initDb = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        sender_id INTEGER NOT NULL,
        receiver_id INTEGER,
        text TEXT,
        image TEXT,
        audio TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (sender_id) REFERENCES users (id)
      )
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS contacts (
        user_id INTEGER NOT NULL,
        contact_id INTEGER NOT NULL,
        PRIMARY KEY (user_id, contact_id),
        FOREIGN KEY (user_id) REFERENCES users (id),
        FOREIGN KEY (contact_id) REFERENCES users (id)
      )
    `);
    console.log('✅ Таблицы готовы');
  } catch (err) {
    console.error('❌ Ошибка создания таблиц:', err);
  }
};

initDb();

module.exports = { pool };