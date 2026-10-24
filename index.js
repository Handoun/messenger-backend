require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('./database');
const { ExpressPeerServer } = require('peer');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: (origin, callback) => callback(null, true),
    credentials: true
  }
});

const peerServer = ExpressPeerServer(server, { path: '/myapp', allow_discovery: true });
app.use('/peerjs', peerServer);

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '50mb' }));

const JWT_SECRET = process.env.JWT_SECRET || 'cbef_super_secret_key_2025_change_me';
const APP_VERSION = '2.1.0';
const PORT = process.env.PORT || 3001;

function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);
  jwt.verify(token, JWT_SECRET, async (err, user) => {
    if (err) return res.sendStatus(403);
    const result = await pool.query('SELECT banned, ban_until, ban_reason FROM users WHERE id = $1', [user.id]);
    if (result.rows.length === 0) return res.sendStatus(403);
    const u = result.rows[0];
    const now = new Date();
    if (u.banned && (u.ban_until === null || u.ban_until > now)) {
      return res.status(403).json({ error: 'You are banned', reason: u.ban_reason, until: u.ban_until });
    }
    req.user = user;
    next();
  });
}

async function isAdmin(userId) {
  const result = await pool.query('SELECT is_admin FROM users WHERE id = $1', [userId]);
  return result.rows[0]?.is_admin === true;
}

async function ensureNewsChannel() {
  try {
    const news = await pool.query(`SELECT * FROM channels WHERE name = 'CBEF-Новости' LIMIT 1`);
    if (news.rows.length === 0) {
      const creator = await pool.query(`SELECT id FROM users WHERE is_admin = true ORDER BY id LIMIT 1`);
      const creatorId = creator.rows.length ? creator.rows[0].id : 1;
      await pool.query(
        `INSERT INTO channels (name, description, creator_id, subscribers_count) VALUES ('CBEF-Новости', 'Официальный новостной канал CBEF', $1, 0)`,
        [creatorId]
      );
      console.log('✅ Канал CBEF-Новости создан');
    }
  } catch (err) { console.error('Ошибка создания новостного канала:', err); }
}

async function autoSubscribeToNews(userId) {
  try {
    const news = await pool.query(`SELECT id FROM channels WHERE name = 'CBEF-Новости' LIMIT 1`);
    if (news.rows.length) {
      const channelId = news.rows[0].id;
      await pool.query('INSERT INTO channel_subscribers (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [channelId, userId]);
      const count = await pool.query('SELECT COUNT(*) FROM channel_subscribers WHERE channel_id = $1', [channelId]);
      await pool.query('UPDATE channels SET subscribers_count = $1 WHERE id = $2', [parseInt(count.rows[0].count), channelId]);
    }
  } catch (err) { console.error('Ошибка автоподписки на новости:', err); }
}

// --- REST API ---

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query('INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id', [username, hashedPassword]);
    const userId = result.rows[0].id;
    await autoSubscribeToNews(userId);
    const token = jwt.sign({ id: userId, username }, JWT_SECRET);
    const deviceInfo = req.headers['user-agent'] || 'Unknown device';
    await pool.query('INSERT INTO sessions (user_id, token, device_info) VALUES ($1, $2, $3)', [userId, token, deviceInfo]);
    res.status(201).json({ token, user: { id: userId, username } });
  } catch (err) {
    if (err.code === '23505') res.status(409).json({ error: 'Username already taken' });
    else { console.error(err); res.status(500).json({ error: 'Server error' }); }
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    if (user.banned) {
      const now = new Date();
      if (user.ban_until === null || user.ban_until > now) {
        return res.status(403).json({ error: 'Account banned', reason: user.ban_reason, until: user.ban_until });
      }
    }
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    await autoSubscribeToNews(user.id);
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
    const deviceInfo = req.headers['user-agent'] || 'Unknown device';
    await pool.query('INSERT INTO sessions (user_id, token, device_info) VALUES ($1, $2, $3)', [user.id, token, deviceInfo]);
    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        avatar: user.avatar,
        isAdmin: user.is_admin,
        bio: user.bio
      }
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/users', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, avatar, bio, is_admin, banned FROM users WHERE id != $1', [req.user.id]);
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/users/search', authenticateToken, async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  try {
    const result = await pool.query('SELECT id, username, avatar FROM users WHERE username ILIKE $1 AND id != $2 LIMIT 10', [`%${q}%`, req.user.id]);
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/users/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username, avatar, bio, is_admin, banned FROM users WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'User not found' });
    res.json(result.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/users/profile', authenticateToken, async (req, res) => {
  const { bio, username } = req.body;
  try {
    if (username && username.trim()) {
      const trimmed = username.trim();
      const existing = await pool.query('SELECT id FROM users WHERE username =  AND id != ', [trimmed, req.user.id]);
      if (existing.rows.length > 0) {
        return res.status(409).json({ error: 'Username already taken' });
      }
      await pool.query('UPDATE users SET username = , bio =  WHERE id = ', [trimmed, bio || '', req.user.id]);
    } else {
      await pool.query('UPDATE users SET bio =  WHERE id = ', [bio || '', req.user.id]);
    }
    const result = await pool.query('SELECT id, username, bio, avatar, is_admin, is_premium FROM users WHERE id = ', [req.user.id]);
    res.json({ success: true, user: result.rows[0] });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/sessions', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, device_info, created_at FROM sessions WHERE user_id = $1 ORDER BY created_at DESC', [req.user.id]);
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.delete('/api/sessions/:id', authenticateToken, async (req, res) => {
  try {
    await pool.query('DELETE FROM sessions WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/messages/:userId', authenticateToken, async (req, res) => {
  const currentUserId = req.user.id;
  const otherUserId = parseInt(req.params.userId);
  try {
    const result = await pool.query(
      `SELECT id, sender_id, receiver_id, text, image, audio, status, created_at 
       FROM messages 
       WHERE (sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1)
       ORDER BY created_at DESC
       LIMIT 100`,
      [currentUserId, otherUserId]
    );
    res.json(result.rows.reverse());
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/contacts', authenticateToken, async (req, res) => {
  const { contactId } = req.body;
  const userId = req.user.id;
  if (!contactId) return res.status(400).json({ error: 'contactId required' });
  try {
    await pool.query('INSERT INTO contacts (user_id, contact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, contactId]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/contacts', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT u.id, u.username, u.avatar FROM contacts c JOIN users u ON c.contact_id = u.id WHERE c.user_id = $1', [req.user.id]);
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/friend-requests', authenticateToken, async (req, res) => {
  const { toId } = req.body;
  const fromId = req.user.id;
  if (!toId) return res.status(400).json({ error: 'toId required' });
  try {
    await pool.query('INSERT INTO friend_requests (from_id, to_id) VALUES ($1, $2)', [fromId, toId]);
    io.to(`user:${toId}`).emit('friend_request', { fromId, fromName: req.user.username });
    res.json({ success: true });
  } catch (err) {
    if (err.code === '23505') res.status(409).json({ error: 'Request already sent' });
    else { console.error(err); res.status(500).json({ error: 'Server error' }); }
  }
});

app.get('/api/friend-requests', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT fr.id, fr.from_id, u.username, u.avatar 
       FROM friend_requests fr 
       JOIN users u ON fr.from_id = u.id 
       WHERE fr.to_id = $1 AND fr.status = 'pending'`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/friend-requests/:id/accept', authenticateToken, async (req, res) => {
  const requestId = parseInt(req.params.id);
  try {
    const reqResult = await pool.query('SELECT * FROM friend_requests WHERE id = $1 AND to_id = $2', [requestId, req.user.id]);
    const request = reqResult.rows[0];
    if (!request) return res.status(404).json({ error: 'Request not found' });
    await pool.query('UPDATE friend_requests SET status = $1 WHERE id = $2', ['accepted', requestId]);
    await pool.query('INSERT INTO contacts (user_id, contact_id) VALUES ($1, $2), ($2, $1) ON CONFLICT DO NOTHING', [request.from_id, request.to_id]);
    io.to(`user:${request.from_id}`).emit('friend_request_accepted', { byId: req.user.id, byName: req.user.username });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/friend-requests/:id/reject', authenticateToken, async (req, res) => {
  const requestId = parseInt(req.params.id);
  try {
    await pool.query('UPDATE friend_requests SET status = $1 WHERE id = $2 AND to_id = $3', ['rejected', requestId, req.user.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/user/avatar', authenticateToken, async (req, res) => {
  const { avatar } = req.body;
  try {
    await pool.query('UPDATE users SET avatar = $1 WHERE id = $2', [avatar, req.user.id]);
    res.json({ success: true, avatar });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// Группы
app.post('/api/groups', authenticateToken, async (req, res) => {
  const { name, memberIds } = req.body;
  const creatorId = req.user.id;
  try {
    const result = await pool.query('INSERT INTO group_chats (name, creator_id) VALUES ($1, $2) RETURNING id', [name, creatorId]);
    const groupId = result.rows[0].id;
    await pool.query('INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)', [groupId, creatorId]);
    if (memberIds?.length) for (const uid of memberIds) await pool.query('INSERT INTO group_members (group_id, user_id) VALUES ($1, $2)', [groupId, uid]);
    res.json({ success: true, groupId });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/groups', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT g.id, g.name, g.creator_id FROM group_chats g JOIN group_members gm ON g.id = gm.group_id WHERE gm.user_id = $1', [req.user.id]);
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/groups/:groupId/messages', authenticateToken, async (req, res) => {
  const groupId = parseInt(req.params.groupId);
  try {
    const result = await pool.query(
      `SELECT m.id, m.sender_id, u.username, u.avatar, m.text, m.image, m.audio, m.status, m.created_at 
       FROM messages m 
       JOIN users u ON m.sender_id = u.id 
       WHERE m.group_id = $1 
       ORDER BY m.created_at DESC 
       LIMIT 100`,
      [groupId]
    );
    res.json(result.rows.reverse());
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// Каналы
app.post('/api/channels', authenticateToken, async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Channel name required' });
  try {
    const result = await pool.query(
      'INSERT INTO channels (name, description, creator_id, subscribers_count) VALUES ($1, $2, $3, 1) RETURNING id',
      [name, description, req.user.id]
    );
    const channelId = result.rows[0].id;
    await pool.query('INSERT INTO channel_subscribers (channel_id, user_id) VALUES ($1, $2)', [channelId, req.user.id]);
    res.json({ success: true, channelId });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/channels/search', authenticateToken, async (req, res) => {
  const { q } = req.query;
  if (!q) return res.json([]);
  try {
    const result = await pool.query('SELECT id, name, description, subscribers_count FROM channels WHERE name ILIKE $1', [`%${q}%`]);
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/channels', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT c.* FROM channels c 
       JOIN channel_subscribers cs ON c.id = cs.channel_id 
       WHERE cs.user_id = $1`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/channels/:id', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM channels WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Channel not found' });
    res.json(result.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/channels/:id/subscribe', authenticateToken, async (req, res) => {
  try {
    await pool.query('INSERT INTO channel_subscribers (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, req.user.id]);
    const countResult = await pool.query('SELECT COUNT(*) FROM channel_subscribers WHERE channel_id = $1', [req.params.id]);
    const subscribersCount = parseInt(countResult.rows[0].count);
    await pool.query('UPDATE channels SET subscribers_count = $1 WHERE id = $2', [subscribersCount, req.params.id]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/channels/:id/subscribers', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT COUNT(*) FROM channel_subscribers WHERE channel_id = $1', [req.params.id]);
    res.json({ count: parseInt(result.rows[0].count) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/channels/:id/messages', authenticateToken, async (req, res) => {
  const channelId = parseInt(req.params.id);
  try {
    const result = await pool.query('SELECT cm.*, u.username, u.avatar FROM channel_messages cm JOIN users u ON cm.sender_id = u.id WHERE cm.channel_id = $1 ORDER BY cm.created_at DESC LIMIT 100', [channelId]);
    res.json(result.rows.reverse());
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/channels/:id/messages', authenticateToken, async (req, res) => {
  const channelId = parseInt(req.params.id);
  const { text, image, audio } = req.body;

  const channelResult = await pool.query('SELECT * FROM channels WHERE id = $1', [channelId]);
  if (channelResult.rows.length === 0) return res.status(404).json({ error: 'Channel not found' });

  const channel = channelResult.rows[0];
  const isNews = channel.name === 'CBEF-Новости';
  const admin = await isAdmin(req.user.id);
  if (isNews && !admin) return res.status(403).json({ error: 'Only admins can post to this channel' });
  if (!isNews && req.user.id !== channel.creator_id && !admin) return res.status(403).json({ error: 'Only creator and admins can post to this channel' });

  try {
    await pool.query('INSERT INTO channel_messages (channel_id, sender_id, text, image, audio) VALUES ($1, $2, $3, $4, $5)', [channelId, req.user.id, text, image, audio]);
    const subscribers = await pool.query('SELECT user_id FROM channel_subscribers WHERE channel_id = $1', [channelId]);
    const message = { id: Date.now(), channel_id: channelId, sender_id: req.user.id, text, image, audio, created_at: new Date().toISOString() };
    subscribers.rows.forEach(s => { io.to(`user:${s.user_id}`).emit('channel_message', message); });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/invite/:channelId', async (req, res) => {
  try {
    const result = await pool.query('SELECT id, name, subscribers_count FROM channels WHERE id = $1', [req.params.channelId]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Channel not found' });
    res.json(result.rows[0]);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// Подписка
app.get('/api/subscription', authenticateToken, async (req, res) => {
  const result = await pool.query('SELECT subscription_until FROM users WHERE id = $1', [req.user.id]);
  res.json({ subscription_until: result.rows[0]?.subscription_until || null });
});

app.put('/api/admin/grant-subscription/:userId', authenticateToken, async (req, res) => {
  if (!await isAdmin(req.user.id)) return res.sendStatus(403);
  const durationDays = parseInt(req.body.durationDays) || 30;
  const newDate = new Date();
  newDate.setDate(newDate.getDate() + durationDays);
  await pool.query('UPDATE users SET subscription_until = $1 WHERE id = $2', [newDate, req.params.userId]);
  res.json({ success: true, subscription_until: newDate });
});

app.put('/api/admin/remove-subscription/:userId', authenticateToken, async (req, res) => {
  if (!await isAdmin(req.user.id)) return res.sendStatus(403);
  await pool.query('UPDATE users SET subscription_until = NULL WHERE id = $1', [req.params.userId]);
  res.json({ success: true });
});

// Админ-система
app.get('/api/admin/users', authenticateToken, async (req, res) => {
  if (!await isAdmin(req.user.id)) return res.sendStatus(403);
  try {
    const result = await pool.query('SELECT id, username, avatar, is_admin, banned, ban_reason, ban_until, subscription_until FROM users');
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/admin/ban/:userId', authenticateToken, async (req, res) => {
  if (!await isAdmin(req.user.id)) return res.sendStatus(403);
  const { reason, durationDays } = req.body;
  try {
    let banUntil = null;
    if (durationDays && durationDays > 0) {
      banUntil = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);
    }
    await pool.query('UPDATE users SET banned = true, ban_reason = $1, ban_until = $2 WHERE id = $3', [reason || null, banUntil, req.params.userId]);
    io.to(`user:${req.params.userId}`).emit('banned', { reason, until: banUntil });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/admin/unban/:userId', authenticateToken, async (req, res) => {
  if (!await isAdmin(req.user.id)) return res.sendStatus(403);
  try {
    await pool.query('UPDATE users SET banned = false, ban_reason = NULL, ban_until = NULL WHERE id = $1', [req.params.userId]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/admin/make-admin/:userId', authenticateToken, async (req, res) => {
  if (!await isAdmin(req.user.id)) return res.sendStatus(403);
  try {
    await pool.query('UPDATE users SET is_admin = true WHERE id = $1', [req.params.userId]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/admin/remove-admin/:userId', authenticateToken, async (req, res) => {
  if (!await isAdmin(req.user.id)) return res.sendStatus(403);
  try {
    await pool.query('UPDATE users SET is_admin = false WHERE id = $1', [req.params.userId]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/admin/reports', authenticateToken, async (req, res) => {
  if (!await isAdmin(req.user.id)) return res.sendStatus(403);
  try {
    const result = await pool.query('SELECT r.*, u.username AS reporter_name, u2.username AS reported_name FROM reports r JOIN users u ON r.reporter_id = u.id JOIN users u2 ON r.reported_user_id = u2.id ORDER BY r.created_at DESC');
    res.json(result.rows);
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/report', authenticateToken, async (req, res) => {
  const { reportedUserId, reason, messageId } = req.body;
  try {
    await pool.query('INSERT INTO reports (reporter_id, reported_user_id, reason, message_id) VALUES ($1, $2, $3, $4)', [req.user.id, reportedUserId, reason, messageId]);
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/version', (req, res) => res.json({ version: APP_VERSION }));

app.put('/api/messages/:userId/delivered', authenticateToken, async (req, res) => {
  const otherUserId = parseInt(req.params.userId);
  try {
    await pool.query(`UPDATE messages SET status = 'delivered' WHERE sender_id = $1 AND receiver_id = $2 AND status = 'sent'`, [otherUserId, req.user.id]);
    io.to(`user:${otherUserId}`).emit('message_status', { receiverId: req.user.id, status: 'delivered' });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

app.put('/api/messages/:userId/read', authenticateToken, async (req, res) => {
  const otherUserId = parseInt(req.params.userId);
  try {
    await pool.query(`UPDATE messages SET status = 'read' WHERE sender_id = $1 AND receiver_id = $2 AND status IN ('sent','delivered')`, [otherUserId, req.user.id]);
    io.to(`user:${otherUserId}`).emit('message_status', { receiverId: req.user.id, status: 'read' });
    res.json({ success: true });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Server error' }); }
});

// --- Socket.IO ---
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication error'));
  jwt.verify(token, JWT_SECRET, async (err, user) => {
    if (err) return next(new Error('Authentication error'));
    const result = await pool.query('SELECT banned, ban_until FROM users WHERE id = $1', [user.id]);
    const u = result.rows[0];
    const now = new Date();
    if (u.banned && (u.ban_until === null || u.ban_until > now)) return next(new Error('Banned'));
    socket.user = user;
    next();
  });
});

const onlineUsers = new Map();

io.on('connection', (socket) => {
  const userId = socket.user.id;
  onlineUsers.set(userId, socket.id);
  io.emit('user_status', { userId, online: true });
  socket.join(`user:${userId}`);

  socket.on('private_message', async ({ to, text, image, audio }) => {
    const senderId = userId;
    try {
      const result = await pool.query(
        'INSERT INTO messages (sender_id, receiver_id, text, image, audio, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at',
        [senderId, to, text || '', image || null, audio || null, 'sent']
      );
      const row = result.rows[0];
      const message = { id: row.id, sender_id: senderId, receiver_id: to, text: text || '', image: image || null, audio: audio || null, status: 'sent', created_at: row.created_at };
      io.to(`user:${to}`).emit('private_message', message);
      socket.emit('private_message', message);
    } catch (err) { console.error('Failed to save message:', err); }
  });

  socket.on('group_message', async ({ groupId, text, image, audio }) => {
    const senderId = userId;
    try {
      const result = await pool.query(
        'INSERT INTO messages (sender_id, group_id, text, image, audio, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at',
        [senderId, groupId, text || '', image || null, audio || null, 'sent']
      );
      const row = result.rows[0];
      const message = { id: row.id, sender_id: senderId, group_id: groupId, text: text || '', image: image || null, audio: audio || null, status: 'sent', created_at: row.created_at };
      const members = await pool.query('SELECT user_id FROM group_members WHERE group_id = $1', [groupId]);
      members.rows.forEach(m => { if (m.user_id !== senderId) io.to(`user:${m.user_id}`).emit('group_message', message); });
      socket.emit('group_message', message);
    } catch (err) { console.error('Failed to save group message:', err); }
  });

  socket.on('channel_message', async ({ channelId, text, image, audio }) => {
    const senderId = userId;
    try {
      await pool.query(
        'INSERT INTO channel_messages (channel_id, sender_id, text, image, audio) VALUES ($1, $2, $3, $4, $5)',
        [channelId, senderId, text || '', image || null, audio || null]
      );
      const message = {
        id: Date.now(),
        channel_id: channelId,
        sender_id: senderId,
        text: text || '',
        image: image || null,
        audio: audio || null,
        created_at: new Date().toISOString()
      };
      const subscribers = await pool.query('SELECT user_id FROM channel_subscribers WHERE channel_id = $1', [channelId]);
      subscribers.rows.forEach(s => {
        io.to(`user:${s.user_id}`).emit('channel_message', message);
      });
    } catch (err) { console.error('Failed to save channel message:', err); }
  });

  socket.on('call_initiate', ({ to, isVideo, callerName, callerAvatar }) => {
    io.to(user:).emit('incoming_call', {
      from: userId,
      callerName: callerName || socket.user.username,
      callerAvatar: callerAvatar || null,
      isVideo: isVideo !== false,
    });
  });

  socket.on('call_response', ({ to, accepted }) => {
    io.to(user:).emit('call_response', {
      from: userId,
      accepted,
    });
  });

  socket.on('call_end', ({ to }) => {
    io.to(user:).emit('call_ended', {
      from: userId,
    });
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(userId);
    io.emit('user_status', { userId, online: false });
  });
});

server.listen(PORT, async () => {
  await ensureNewsChannel();
  console.log(`Server running on port ${PORT}`);
  console.log(`PeerJS running on /peerjs`);
});
