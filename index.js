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
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    credentials: true
  }
});

// PeerJS сервер
const peerServer = ExpressPeerServer(server, {
  path: '/myapp',
  allow_discovery: true
});
app.use('/peerjs', peerServer);

app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));

const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_change_me';
const PORT = process.env.PORT || 3001;

// Middleware для JWT
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

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
    origin: process.env.CLIENT_URL || 'http://localhost:5173',
    credentials: true
  }
});

// PeerJS сервер
const peerServer = ExpressPeerServer(server, {
  path: '/myapp',
  allow_discovery: true
});
app.use('/peerjs', peerServer);

app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:5173',
  credentials: true
}));
app.use(express.json({ limit: '50mb' }));

const JWT_SECRET = process.env.JWT_SECRET || 'default_secret_change_me';
const PORT = process.env.PORT || 3001;

// Middleware для JWT
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.sendStatus(401);
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.sendStatus(403);
    req.user = user;
    next();
  });
}

// --- REST API ---

app.post('/api/register', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const result = await pool.query(
      'INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id',
      [username, hashedPassword]
    );
    const userId = result.rows[0].id;
    const token = jwt.sign({ id: userId, username }, JWT_SECRET);
    res.status(201).json({ token, user: { id: userId, username } });
  } catch (err) {
    if (err.code === '23505') {
      res.status(409).json({ error: 'Username already taken' });
    } else {
      console.error(err);
      res.status(500).json({ error: 'Server error' });
    }
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  try {
    const result = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
    res.json({ token, user: { id: user.id, username: user.username } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/users', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT id, username FROM users WHERE id != $1', [req.user.id]);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/messages/:userId', authenticateToken, async (req, res) => {
  const currentUserId = req.user.id;
  const otherUserId = parseInt(req.params.userId);
  try {
    const result = await pool.query(
      `SELECT id, sender_id, receiver_id, text, image, audio, created_at 
       FROM messages 
       WHERE (sender_id = $1 AND receiver_id = $2) 
          OR (sender_id = $2 AND receiver_id = $1)
       ORDER BY created_at ASC`,
      [currentUserId, otherUserId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/contacts', authenticateToken, async (req, res) => {
  const { contactId } = req.body;
  const userId = req.user.id;
  if (!contactId) return res.status(400).json({ error: 'contactId required' });
  try {
    await pool.query(
      'INSERT INTO contacts (user_id, contact_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, contactId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/contacts', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT u.id, u.username FROM contacts c
       JOIN users u ON c.contact_id = u.id
       WHERE c.user_id = $1`,
      [req.user.id]
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Server error' });
  }
});

// --- Socket.IO ---
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('Authentication error'));
  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return next(new Error('Authentication error'));
    socket.user = user;
    next();
  });
});

const onlineUsers = new Map();

io.on('connection', (socket) => {
  const userId = socket.user.id;
  onlineUsers.set(userId, socket.id);
  console.log(`User ${socket.user.username} connected`);

  io.emit('user_status', { userId, online: true });
  socket.join(`user:${userId}`);

  socket.on('private_message', async ({ to, text, image, audio }) => {
    const senderId = userId;
    try {
      const result = await pool.query(
        'INSERT INTO messages (sender_id, receiver_id, text, image, audio) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at',
        [senderId, to, text || '', image || null, audio || null]
      );
      const row = result.rows[0];
      const message = {
        id: row.id,
        sender_id: senderId,
        receiver_id: to,
        text: text || '',
        image: image || null,
        audio: audio || null,
        created_at: row.created_at
      };
      io.to(`user:${to}`).emit('private_message', message);
      socket.emit('private_message', message);
    } catch (err) {
      console.error('Failed to save message:', err);
    }
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(userId);
    io.emit('user_status', { userId, online: false });
    console.log(`User ${socket.user.username} disconnected`);
  });
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`PeerJS running on /peerjs`);
});