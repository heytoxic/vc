require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const MongoStore = require('connect-mongo');
const { Server } = require('socket.io');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ── 1. MongoDB Connection ──
mongoose.connect(process.env.MONGO_URI || 'mongodb+srv://knight_rider:GODGURU12345@knight.jm59gu9.mongodb.net/?retryWrites=true&w=majority')
  .then(() => console.log("✅ MongoDB Connected"))
  .catch(err => console.log("❌ MongoDB Error:", err));

// ── 2. User Schema ──
const userSchema = new mongoose.Schema({
  name: String,
  email: { type: String, unique: true, required: true },
  password: { type: String },
  verified: { type: Boolean, default: false },
  roomId: String,
  createdAt: { type: Date, default: Date.now },
  loginCount: { type: Number, default: 0 },
  lastLogin: Date,
  loginMethod: { type: String, default: 'email' },
  igUsername: String,
  igId: String,
  otp: { code: String, expires: Date, type: String }
});
const User = mongoose.model('User', userSchema);

const rooms = {}; 

// ── 3. Middleware ──
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'toxiclabs_secret_2025',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({ mongoUrl: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/toxiclabs' }),
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
});

// ── 4. Telegram & Email Helpers (Fast Async) ──
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
  const subject = type === 'verify' ? '✅ Verify your Instagram Video Call account' : '🔐 Your login OTP';
  const html = `
  <!DOCTYPE html>
  <html>
  <body style="margin:0;padding:0;background:#f5f5f5;font-family:Arial,sans-serif">
    <div style="max-width:500px;margin:20px auto;background:#fff;border-radius:15px;overflow:hidden;border:1px solid #ddd">
      <div style="background:linear-gradient(135deg,#833ab4,#fd1d1d,#fcb045);padding:25px;text-align:center;color:#fff">
        <h2>Instagram Video Call</h2>
      </div>
      <div style="padding:30px;text-align:center">
        <p>Hi <b>${name}</b>,</p>
        <p>Use the code below to ${type === 'verify' ? 'verify your account' : 'log in'}:</p>
        <div style="font-size:35px;font-weight:bold;letter-spacing:5px;margin:20px 0;color:#262626">${otp}</div>
        <p style="color:#8e8e8e;font-size:12px">Expires in 10 minutes</p>
      </div>
    </div>
  </body>
  </html>`;

  mailer.sendMail({ from: `"IG Video Call" <${process.env.MAIL_USER}>`, to: email, subject, html }).catch(() => {});
}

function genOTP() { return Math.floor(100000 + Math.random() * 900000).toString(); }
function genRoomId() { return uuidv4().replace(/-/g, '').slice(0, 8).toUpperCase(); }

// ── 5. Auth API ──
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  const existing = await User.findOne({ email });
  if (existing) return res.json({ ok: false, msg: 'Email already registered' });

  const hash = await bcrypt.hash(password, 10);
  const otp = genOTP();
  const roomId = genRoomId();

  const user = new User({ name: name.trim(), email, password: hash, roomId, otp: { code: otp, expires: Date.now() + 600000, type: 'verify' } });
  await user.save();
  
  sendOTP(email, name, otp, 'verify');
  sendTelegram(`🆕 <b>New Registration</b>\n👤 ${name}\n📧 ${email}`);
  res.json({ ok: true, msg: 'OTP sent to email.' });
});

app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  const user = await User.findOne({ email });
  if (!user) return res.json({ ok: false, msg: 'No account found' });

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.json({ ok: false, msg: 'Incorrect password' });

  const otp = genOTP();
  user.otp = { code: otp, expires: Date.now() + 600000, type: user.verified ? 'login' : 'verify' };
  await user.save();

  sendOTP(email, user.name, otp, user.otp.type);
  res.json({ ok: true, msg: 'OTP sent.', needsOTP: true });
});

app.post('/api/verify-otp', async (req, res) => {
  const { email, otp, type } = req.body;
  const user = await User.findOne({ email });
  if (!user || !user.otp || user.otp.code !== otp.toString()) return res.json({ ok: false, msg: 'Invalid OTP' });

  user.otp = undefined;
  if (type === 'verify') user.verified = true;
  await user.save();

  req.session.userId = email;
  res.json({ ok: true, msg: 'Success!', user: safeUser(user) });
});

app.get('/api/me', async (req, res) => {
  if (!req.session.userId) return res.json({ ok: false });
  const user = await User.findOne({ email: req.session.userId });
  res.json({ ok: true, user: safeUser(user) });
});

function safeUser(u) { return u ? { name: u.name, email: u.email, roomId: u.roomId } : null; }

// ── 6. Socket.io WebRTC Logic ──
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

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

server.listen(3000, () => console.log("🚀 Running on http://localhost:3000"));
