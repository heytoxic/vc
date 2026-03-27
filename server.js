require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ── In-memory stores (replace with DB in production) ──
const users = {};       // email -> user object
const otps = {};        // email -> { code, expires, type }
const rooms = {};       // roomId -> { host, participants, created }
const sessions = {};    // sessionId -> userId

// ── Middleware ──
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'toxiclabs_secret_2025',
  resave: false,
  saveUninitialized: false,
  cookie: { secure: false, maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 days
}));

// ── Email transporter ──
const mailer = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
});

// ── Telegram notifier ──
async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML'
      })
    });
  } catch (e) {
    console.log('[Telegram Error]', e.message);
  }
}

// ── OTP email sender ──
async function sendOTP(email, name, otp, type) {
  const subject = type === 'verify'
    ? '✅ Verify your Instagram Video Call account'
    : '🔐 Your login OTP — Instagram Video Call';

  const html = `
  <!DOCTYPE html>
  <html>
  <head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="margin:0;padding:0;background:#f5f5f5;font-family:'Segoe UI',Arial,sans-serif">
    <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08)">
      <!-- Header -->
      <div style="background:linear-gradient(135deg,#833ab4,#fd1d1d,#fcb045);padding:36px 32px;text-align:center">
        <div style="width:60px;height:60px;background:rgba(255,255,255,0.2);border-radius:16px;margin:0 auto 16px;display:flex;align-items:center;justify-content:center;font-size:30px;line-height:60px">📷</div>
        <h1 style="color:#fff;margin:0;font-size:22px;font-weight:800;letter-spacing:-0.5px">Instagram Video Call</h1>
        <p style="color:rgba(255,255,255,0.8);margin:6px 0 0;font-size:13px">by ToxicLabs · End-to-End Encrypted</p>
      </div>
      <!-- Body -->
      <div style="padding:36px 32px">
        <p style="color:#262626;font-size:15px;font-weight:600;margin:0 0 8px">Hi ${name} 👋</p>
        <p style="color:#8e8e8e;font-size:14px;line-height:1.6;margin:0 0 28px">
          ${type === 'verify'
            ? 'Welcome! Use the OTP below to verify your email and activate your account.'
            : 'Use the OTP below to complete your sign-in. This code expires in 10 minutes.'}
        </p>
        <!-- OTP Box -->
        <div style="background:#fafafa;border:2px dashed #e0e0e0;border-radius:16px;padding:28px;text-align:center;margin-bottom:28px">
          <p style="color:#8e8e8e;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 12px">Your One-Time Password</p>
          <div style="font-size:42px;font-weight:900;letter-spacing:10px;color:#262626;font-family:'Courier New',monospace">${otp}</div>
          <p style="color:#aaa;font-size:12px;margin:12px 0 0">⏱ Expires in 10 minutes</p>
        </div>
        <div style="background:#fff8e1;border:1px solid #ffe082;border-radius:10px;padding:14px 16px;margin-bottom:24px">
          <p style="color:#795548;font-size:12px;font-weight:600;margin:0">🔒 <strong>Security tip:</strong> Never share this OTP with anyone. ToxicLabs will never ask for your OTP.</p>
        </div>
        <p style="color:#aaa;font-size:12px;margin:0">If you didn't request this, you can safely ignore this email.</p>
      </div>
      <!-- Footer -->
      <div style="background:#fafafa;border-top:1px solid #efefef;padding:20px 32px;text-align:center">
        <p style="color:#aaa;font-size:11px;margin:0">© 2025 Instagram Video Call by <strong>ToxicLabs</strong> · toxiclabs.xyz</p>
      </div>
    </div>
  </body>
  </html>`;

  await mailer.sendMail({
    from: `"Instagram Video Call" <${process.env.MAIL_USER}>`,
    to: email,
    subject,
    html
  });
}

// ── Auth helpers ──
function genOTP() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

function genRoomId() {
  return uuidv4().replace(/-/g, '').slice(0, 8).toUpperCase();
}

function isLoggedIn(req, res, next) {
  if (req.session.userId && users[req.session.userId]) return next();
  res.status(401).json({ ok: false, msg: 'Not authenticated' });
}

// ══════════════════════════════════
//  API ROUTES
// ══════════════════════════════════

// ── REGISTER ──
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.json({ ok: false, msg: 'All fields required' });

  if (password.length < 6)
    return res.json({ ok: false, msg: 'Password must be at least 6 characters' });

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email))
    return res.json({ ok: false, msg: 'Invalid email address' });

  if (users[email])
    return res.json({ ok: false, msg: 'Email already registered' });

  const hash = await bcrypt.hash(password, 10);
  const otp = genOTP();
  const roomId = genRoomId();

  // Store temporarily until verified
  users[email] = {
    id: email,
    name: name.trim(),
    email,
    password: hash,
    verified: false,
    roomId,
    createdAt: new Date().toISOString(),
    loginCount: 0,
    lastLogin: null,
    loginMethod: 'email'
  };

  otps[email] = { code: otp, expires: Date.now() + 10 * 60 * 1000, type: 'verify' };

  try {
    await sendOTP(email, name, otp, 'verify');
  } catch (e) {
    console.log('[Mail Error]', e.message);
    // continue even if mail fails in dev
  }

  // Telegram notification
  await sendTelegram(
    `🆕 <b>New Registration</b>\n👤 Name: ${name}\n📧 Email: ${email}\n🕐 Time: ${new Date().toLocaleString('en-IN')}\n🌍 Room: ${roomId}`
  );

  res.json({ ok: true, msg: 'OTP sent to your email. Check inbox.' });
});

// ── VERIFY OTP ──
app.post('/api/verify-otp', (req, res) => {
  const { email, otp, type } = req.body;
  const record = otps[email];

  if (!record) return res.json({ ok: false, msg: 'No OTP found. Request again.' });
  if (Date.now() > record.expires) {
    delete otps[email];
    return res.json({ ok: false, msg: 'OTP expired. Request a new one.' });
  }
  if (record.code !== otp.toString()) {
    return res.json({ ok: false, msg: 'Incorrect OTP. Try again.' });
  }

  delete otps[email];

  if (type === 'verify') {
    if (users[email]) users[email].verified = true;
    req.session.userId = email;
    return res.json({ ok: true, msg: 'Email verified! Welcome aboard.', user: safeUser(users[email]) });
  }

  if (type === 'login') {
    if (!users[email]) return res.json({ ok: false, msg: 'User not found' });
    users[email].loginCount++;
    users[email].lastLogin = new Date().toISOString();
    req.session.userId = email;
    return res.json({ ok: true, msg: 'Logged in successfully!', user: safeUser(users[email]) });
  }

  res.json({ ok: false, msg: 'Invalid OTP type' });
});

// ── RESEND OTP ──
app.post('/api/resend-otp', async (req, res) => {
  const { email, type } = req.body;
  if (!users[email]) return res.json({ ok: false, msg: 'Email not registered' });

  const otp = genOTP();
  otps[email] = { code: otp, expires: Date.now() + 10 * 60 * 1000, type };

  try {
    await sendOTP(email, users[email].name, otp, type);
  } catch (e) {
    console.log('[Mail Error]', e.message);
  }

  res.json({ ok: true, msg: 'OTP resent to your email.' });
});

// ── LOGIN ──
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password)
    return res.json({ ok: false, msg: 'Email and password required' });

  const user = users[email];
  if (!user) return res.json({ ok: false, msg: 'No account found with this email' });

  const match = await bcrypt.compare(password, user.password);
  if (!match) return res.json({ ok: false, msg: 'Incorrect password' });

  if (!user.verified) {
    // Resend OTP
    const otp = genOTP();
    otps[email] = { code: otp, expires: Date.now() + 10 * 60 * 1000, type: 'verify' };
    try { await sendOTP(email, user.name, otp, 'verify'); } catch (e) {}
    return res.json({ ok: false, msg: 'Email not verified. OTP resent.', needsVerify: true });
  }

  // Send login OTP
  const otp = genOTP();
  otps[email] = { code: otp, expires: Date.now() + 10 * 60 * 1000, type: 'login' };
  try { await sendOTP(email, user.name, otp, 'login'); } catch (e) {}

  await sendTelegram(
    `🔐 <b>Login Attempt</b>\n👤 ${user.name}\n📧 ${email}\n🕐 ${new Date().toLocaleString('en-IN')}`
  );

  res.json({ ok: true, msg: 'OTP sent to your email for login.', needsOTP: true });
});

// ── INSTAGRAM OAUTH ──
app.get('/auth/instagram/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=ig_cancelled');

  try {
    // Exchange code for token
    const tokenRes = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: process.env.IG_APP_ID,
        client_secret: process.env.IG_APP_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: process.env.IG_REDIRECT_URI,
        code
      })
    });
    const tokenData = await tokenRes.json();

    // Get user profile
    const profileRes = await fetch(
      `https://graph.instagram.com/me?fields=id,username&access_token=${tokenData.access_token}`
    );
    const profile = await profileRes.json();

    const igEmail = `ig_${profile.id}@instagram.local`;
    const igName = profile.username || `ig_${profile.id}`;

    if (!users[igEmail]) {
      const roomId = genRoomId();
      users[igEmail] = {
        id: igEmail,
        name: igName,
        email: igEmail,
        password: null,
        verified: true,
        roomId,
        createdAt: new Date().toISOString(),
        loginCount: 1,
        lastLogin: new Date().toISOString(),
        loginMethod: 'instagram',
        igUsername: igName,
        igId: profile.id
      };

      await sendTelegram(
        `📷 <b>Instagram Login (New User)</b>\n👤 @${igName}\n🆔 IG ID: ${profile.id}\n🕐 ${new Date().toLocaleString('en-IN')}`
      );
    } else {
      users[igEmail].loginCount++;
      users[igEmail].lastLogin = new Date().toISOString();
    }

    req.session.userId = igEmail;
    res.redirect('/?loggedin=1');
  } catch (e) {
    console.log('[IG OAuth Error]', e.message);
    res.redirect('/?error=ig_failed');
  }
});

// ── LOGOUT ──
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// ── GET CURRENT USER ──
app.get('/api/me', isLoggedIn, (req, res) => {
  res.json({ ok: true, user: safeUser(users[req.session.userId]) });
});

// ── CREATE ROOM ──
app.post('/api/room/create', isLoggedIn, (req, res) => {
  const user = users[req.session.userId];
  const roomId = user.roomId; // use their pre-assigned room
  rooms[roomId] = {
    id: roomId,
    host: user.email,
    hostName: user.name,
    participants: [],
    created: new Date().toISOString(),
    active: true
  };

  const inviteLink = `${process.env.DOMAIN || 'https://toxiclabs.xyz'}/join/${roomId}?from=${encodeURIComponent(user.name)}`;

  sendTelegram(
    `📞 <b>Room Created</b>\n👤 ${user.name}\n📧 ${user.email}\n🏠 Room: ${roomId}\n🔗 ${inviteLink}\n🕐 ${new Date().toLocaleString('en-IN')}`
  );

  res.json({ ok: true, roomId, inviteLink });
});

// ── JOIN ROOM ──
app.post('/api/room/join', isLoggedIn, (req, res) => {
  const { roomId } = req.body;
  const user = users[req.session.userId];

  if (!rooms[roomId]) {
    // Create it if doesn't exist yet (host hasn't started)
    rooms[roomId] = {
      id: roomId, host: null, hostName: null,
      participants: [], created: new Date().toISOString(), active: true
    };
  }

  sendTelegram(
    `🚪 <b>Room Joined</b>\n👤 ${user.name}\n📧 ${user.email}\n🏠 Room: ${roomId}\n🕐 ${new Date().toLocaleString('en-IN')}`
  );

  res.json({ ok: true, roomId, room: rooms[roomId] });
});

// ── SAVE USERS to data.json ──
function saveData() {
  const data = { users: Object.values(users).map(safeUser), rooms: Object.values(rooms), savedAt: new Date().toISOString() };
  fs.writeFileSync(path.join(__dirname, 'data.json'), JSON.stringify(data, null, 2));
}

function safeUser(u) {
  if (!u) return null;
  return { name: u.name, email: u.email, verified: u.verified, roomId: u.roomId, createdAt: u.createdAt, loginMethod: u.loginMethod, igUsername: u.igUsername || null };
}

// Save every 30s
setInterval(saveData, 30000);

// ══════════════════════════════════
//  SOCKET.IO — WebRTC Signaling
// ══════════════════════════════════
io.on('connection', (socket) => {
  console.log('[Socket] Connected:', socket.id);

  socket.on('join-room', ({ roomId, userName }) => {
    socket.join(roomId);
    socket.roomId = roomId;
    socket.userName = userName;

    if (!rooms[roomId]) {
      rooms[roomId] = { id: roomId, host: null, hostName: userName, participants: [], created: new Date().toISOString(), active: true };
    }

    if (!rooms[roomId].participants.includes(userName)) {
      rooms[roomId].participants.push(userName);
    }

    // Notify others in room
    socket.to(roomId).emit('user-joined', { socketId: socket.id, userName });
    // Send current participants to new joiner
    const others = [...io.sockets.adapter.rooms.get(roomId) || []].filter(id => id !== socket.id);
    socket.emit('room-peers', others);

    console.log(`[Room] ${userName} joined ${roomId}`);
  });

  // WebRTC offer
  socket.on('offer', ({ to, offer }) => {
    io.to(to).emit('offer', { from: socket.id, offer, userName: socket.userName });
  });

  // WebRTC answer
  socket.on('answer', ({ to, answer }) => {
    io.to(to).emit('answer', { from: socket.id, answer });
  });

  // ICE candidates
  socket.on('ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('ice-candidate', { from: socket.id, candidate });
  });

  // User left
  socket.on('disconnect', () => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit('user-left', { socketId: socket.id, userName: socket.userName });
      if (rooms[socket.roomId]) {
        rooms[socket.roomId].participants = rooms[socket.roomId].participants.filter(p => p !== socket.userName);
      }
    }
  });
});

// ── Serve frontend for all routes ──
app.get('/join/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 ToxicLabs IGVC Server running on http://localhost:${PORT}`);
  console.log(`📷 Instagram Video Call — by Toxic\n`);
});
