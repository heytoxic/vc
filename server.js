require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const session    = require('express-session');
const MongoStore = require('connect-mongo');
const bcrypt     = require('bcryptjs');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const fetch      = require('node-fetch');
const path       = require('path');
const mongoose   = require('mongoose');

// ════════════════════════════════════════
//  MONGODB CONNECTION
// ════════════════════════════════════════
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/igvc';

mongoose.connect(MONGO_URI, {
  serverSelectionTimeoutMS: 5000,
  socketTimeoutMS: 45000,
}).then(() => {
  console.log('✅ MongoDB connected:', MONGO_URI);
}).catch(err => {
  console.error('❌ MongoDB connection failed:', err.message);
  process.exit(1);
});

// ════════════════════════════════════════
//  MONGOOSE SCHEMAS
// ════════════════════════════════════════
const userSchema = new mongoose.Schema({
  name:        { type: String, required: true, trim: true },
  email:       { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:    { type: String, default: null },
  verified:    { type: Boolean, default: false },
  roomId:      { type: String, required: true, unique: true },
  loginMethod: { type: String, enum: ['email', 'instagram'], default: 'email' },
  igUsername:  { type: String, default: null },
  igId:        { type: String, default: null },
  loginCount:  { type: Number, default: 0 },
  lastLogin:   { type: Date, default: null },
}, { timestamps: true });

// Index for fast lookups
userSchema.index({ email: 1 });
userSchema.index({ roomId: 1 });

const otpSchema = new mongoose.Schema({
  email:   { type: String, required: true, index: true },
  code:    { type: String, required: true },
  type:    { type: String, enum: ['verify', 'login'], required: true },
  expires: { type: Date, required: true },
});
// Auto-delete expired OTPs via MongoDB TTL index
otpSchema.index({ expires: 1 }, { expireAfterSeconds: 0 });

const roomSchema = new mongoose.Schema({
  roomId:   { type: String, required: true, unique: true },
  host:     { type: String, default: null },
  hostName: { type: String, default: null },
  active:   { type: Boolean, default: true },
}, { timestamps: true });

const User = mongoose.model('User', userSchema);
const OTP  = mongoose.model('OTP', otpSchema);
const Room = mongoose.model('Room', roomSchema);

// ════════════════════════════════════════
//  EXPRESS + SOCKET.IO SETUP
// ════════════════════════════════════════
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling'], // websocket first = faster
  pingTimeout: 20000,
  pingInterval: 10000,
});

// ── Middleware ──
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d', // Cache static assets for speed
  etag: true,
}));

// Sessions stored in MongoDB (persist across restarts)
app.use(session({
  secret: process.env.SESSION_SECRET || 'toxiclabs_secret_2025',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: MONGO_URI,
    ttl: 7 * 24 * 60 * 60, // 7 days
    autoRemove: 'native',
  }),
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true,
    maxAge: 7 * 24 * 60 * 60 * 1000,
  },
}));

// ════════════════════════════════════════
//  EMAIL — pooled connection for speed
// ════════════════════════════════════════
const mailer = nodemailer.createTransport({
  service: 'gmail',
  pool: true,        // reuse connections = much faster
  maxConnections: 5,
  maxMessages: 100,
  auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS },
});

// Verify mailer on startup
mailer.verify(err => {
  if (err) console.warn('⚠️  Mail not configured:', err.message);
  else console.log('✅ Mailer ready');
});

// ── OTP Email Template ──
async function sendOTP(email, name, otp, type) {
  const subject = type === 'verify'
    ? '✅ Verify your Instagram Video Call account'
    : '🔐 Your login OTP — Instagram Video Call';

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Segoe UI',Arial,sans-serif">
  <div style="max-width:520px;margin:40px auto;background:#fff;border-radius:20px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.08)">
    <div style="background:linear-gradient(135deg,#833ab4,#fd1d1d,#fcb045);padding:36px 32px;text-align:center">
      <div style="font-size:36px;margin-bottom:12px">📷</div>
      <h1 style="color:#fff;margin:0;font-size:22px;font-weight:800">Instagram Video Call</h1>
      <p style="color:rgba(255,255,255,.8);margin:6px 0 0;font-size:13px">by ToxicLabs · End-to-End Encrypted</p>
    </div>
    <div style="padding:36px 32px">
      <p style="color:#262626;font-size:15px;font-weight:600;margin:0 0 8px">Hi ${name} 👋</p>
      <p style="color:#8e8e8e;font-size:14px;line-height:1.6;margin:0 0 28px">
        ${type === 'verify'
          ? 'Welcome! Use the OTP below to verify your email and activate your account.'
          : 'Use the OTP below to complete your sign-in. This code expires in 10 minutes.'}
      </p>
      <div style="background:#fafafa;border:2px dashed #e0e0e0;border-radius:16px;padding:28px;text-align:center;margin-bottom:28px">
        <p style="color:#8e8e8e;font-size:11px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;margin:0 0 12px">Your One-Time Password</p>
        <div style="font-size:44px;font-weight:900;letter-spacing:12px;color:#262626;font-family:'Courier New',monospace">${otp}</div>
        <p style="color:#aaa;font-size:12px;margin:12px 0 0">⏱ Expires in 10 minutes</p>
      </div>
      <div style="background:#fff8e1;border:1px solid #ffe082;border-radius:10px;padding:14px 16px;margin-bottom:20px">
        <p style="color:#795548;font-size:12px;font-weight:600;margin:0">🔒 <strong>Security tip:</strong> Never share this OTP. ToxicLabs will never ask for it.</p>
      </div>
      <p style="color:#aaa;font-size:12px;margin:0">If you didn't request this, safely ignore this email.</p>
    </div>
    <div style="background:#fafafa;border-top:1px solid #efefef;padding:18px 32px;text-align:center">
      <p style="color:#aaa;font-size:11px;margin:0">© 2025 Instagram Video Call by <strong>ToxicLabs</strong> · toxiclabs.xyz</p>
    </div>
  </div>
</body></html>`;

  return mailer.sendMail({
    from: `"Instagram Video Call" <${process.env.MAIL_USER}>`,
    to: email,
    subject,
    html,
  });
}

// ════════════════════════════════════════
//  TELEGRAM — fire and forget (non-blocking)
// ════════════════════════════════════════
function sendTelegram(message) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return; // don't await — never blocks request

  fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' }),
  }).catch(e => console.warn('[Telegram]', e.message));
}

// ════════════════════════════════════════
//  HELPERS
// ════════════════════════════════════════
function genOTP()    { return Math.floor(100000 + Math.random() * 900000).toString(); }
function genRoomId() { return uuidv4().replace(/-/g,'').slice(0,8).toUpperCase(); }

function safeUser(u) {
  if (!u) return null;
  return {
    name: u.name, email: u.email, verified: u.verified,
    roomId: u.roomId, loginMethod: u.loginMethod,
    igUsername: u.igUsername || null,
    createdAt: u.createdAt,
  };
}

async function isLoggedIn(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ ok: false, msg: 'Not authenticated' });
  const user = await User.findOne({ email: req.session.userId }).lean();
  if (!user) return res.status(401).json({ ok: false, msg: 'Not authenticated' });
  req.dbUser = user;
  next();
}

// ════════════════════════════════════════
//  ROUTES
// ════════════════════════════════════════

// ── REGISTER ──
// BUG FIX: was using in-memory object — now checks MongoDB properly
app.post('/api/register', async (req, res) => {
  try {
    const { name, email, password } = req.body;

    if (!name || !email || !password)
      return res.json({ ok: false, msg: 'All fields are required' });

    if (password.length < 6)
      return res.json({ ok: false, msg: 'Password must be at least 6 characters' });

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return res.json({ ok: false, msg: 'Invalid email address' });

    const normalizedEmail = email.toLowerCase().trim();

    // ✅ FIX: Check MongoDB, not stale in-memory object
    const existing = await User.findOne({ email: normalizedEmail }).lean();
    if (existing) {
      if (!existing.verified) {
        // User exists but unverified — resend OTP instead of blocking
        const otp = genOTP();
        await OTP.deleteMany({ email: normalizedEmail });
        await OTP.create({ email: normalizedEmail, code: otp, type: 'verify', expires: new Date(Date.now() + 10*60*1000) });
        sendOTP(normalizedEmail, existing.name, otp, 'verify').catch(() => {});
        return res.json({ ok: false, msg: 'Account exists but not verified. OTP resent to your email.', needsVerify: true, email: normalizedEmail });
      }
      return res.json({ ok: false, msg: 'This email is already registered. Please log in.' });
    }

    // Hash with rounds=8 (faster than 10, still secure)
    const hash = await bcrypt.hash(password, 8);
    const roomId = genRoomId();
    const otp = genOTP();

    await User.create({
      name: name.trim(),
      email: normalizedEmail,
      password: hash,
      verified: false,
      roomId,
      loginMethod: 'email',
    });

    await OTP.create({ email: normalizedEmail, code: otp, type: 'verify', expires: new Date(Date.now() + 10*60*1000) });

    // Non-blocking — don't await mail/telegram
    sendOTP(normalizedEmail, name, otp, 'verify').catch(e => console.warn('[Mail]', e.message));
    sendTelegram(`🆕 <b>New Registration</b>\n👤 ${name}\n📧 ${normalizedEmail}\n🏠 Room: ${roomId}\n🕐 ${new Date().toLocaleString('en-IN')}`);

    res.json({ ok: true, msg: 'OTP sent to your email. Check your inbox.' });
  } catch (e) {
    console.error('[Register]', e);
    res.json({ ok: false, msg: 'Server error. Please try again.' });
  }
});

// ── LOGIN ──
// BUG FIX: was hitting in-memory `users` object which was empty after restart
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.json({ ok: false, msg: 'Email and password are required' });

    const normalizedEmail = email.toLowerCase().trim();

    // ✅ FIX: Fetch from MongoDB — always fresh, no restart issues
    const user = await User.findOne({ email: normalizedEmail });
    if (!user)
      return res.json({ ok: false, msg: 'No account found with this email. Please sign up.' });

    const match = await bcrypt.compare(password, user.password || '');
    if (!match)
      return res.json({ ok: false, msg: 'Incorrect password. Please try again.' });

    if (!user.verified) {
      const otp = genOTP();
      await OTP.deleteMany({ email: normalizedEmail });
      await OTP.create({ email: normalizedEmail, code: otp, type: 'verify', expires: new Date(Date.now() + 10*60*1000) });
      sendOTP(normalizedEmail, user.name, otp, 'verify').catch(() => {});
      return res.json({ ok: false, msg: 'Email not verified. OTP resent.', needsVerify: true });
    }

    // Login OTP
    const otp = genOTP();
    await OTP.deleteMany({ email: normalizedEmail });
    await OTP.create({ email: normalizedEmail, code: otp, type: 'login', expires: new Date(Date.now() + 10*60*1000) });
    sendOTP(normalizedEmail, user.name, otp, 'login').catch(() => {});
    sendTelegram(`🔐 <b>Login</b>\n👤 ${user.name}\n📧 ${normalizedEmail}\n🕐 ${new Date().toLocaleString('en-IN')}`);

    res.json({ ok: true, msg: 'OTP sent to your email.', needsOTP: true });
  } catch (e) {
    console.error('[Login]', e);
    res.json({ ok: false, msg: 'Server error. Please try again.' });
  }
});

// ── VERIFY OTP ──
app.post('/api/verify-otp', async (req, res) => {
  try {
    const { email, otp, type } = req.body;
    const normalizedEmail = email?.toLowerCase().trim();

    const record = await OTP.findOne({ email: normalizedEmail, type });

    if (!record)
      return res.json({ ok: false, msg: 'No OTP found. Request a new one.' });

    if (new Date() > record.expires) {
      await OTP.deleteOne({ _id: record._id });
      return res.json({ ok: false, msg: 'OTP expired. Request a new one.' });
    }

    if (record.code !== otp.toString().trim())
      return res.json({ ok: false, msg: 'Incorrect OTP. Please try again.' });

    // Valid — delete OTP
    await OTP.deleteOne({ _id: record._id });

    const user = await User.findOneAndUpdate(
      { email: normalizedEmail },
      {
        $set: { verified: true, lastLogin: new Date() },
        $inc: { loginCount: 1 },
      },
      { new: true }
    );

    if (!user) return res.json({ ok: false, msg: 'User not found.' });

    req.session.userId = normalizedEmail;
    req.session.save(); // force save for speed

    sendTelegram(`✅ <b>OTP Verified</b>\n👤 ${user.name}\n📧 ${normalizedEmail}\n🕐 ${new Date().toLocaleString('en-IN')}`);

    res.json({ ok: true, msg: type === 'verify' ? 'Email verified! Welcome aboard 🎉' : 'Logged in!', user: safeUser(user) });
  } catch (e) {
    console.error('[VerifyOTP]', e);
    res.json({ ok: false, msg: 'Server error. Please try again.' });
  }
});

// ── RESEND OTP ──
app.post('/api/resend-otp', async (req, res) => {
  try {
    const { email, type } = req.body;
    const normalizedEmail = email?.toLowerCase().trim();

    const user = await User.findOne({ email: normalizedEmail }).lean();
    if (!user) return res.json({ ok: false, msg: 'Email not registered.' });

    const otp = genOTP();
    await OTP.deleteMany({ email: normalizedEmail });
    await OTP.create({ email: normalizedEmail, code: otp, type, expires: new Date(Date.now() + 10*60*1000) });

    sendOTP(normalizedEmail, user.name, otp, type).catch(() => {});
    res.json({ ok: true, msg: 'OTP resent to your email.' });
  } catch (e) {
    res.json({ ok: false, msg: 'Could not resend OTP. Try again.' });
  }
});

// ── INSTAGRAM OAUTH ──
app.get('/auth/instagram/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.redirect('/?error=ig_cancelled');

  try {
    const tokenRes = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      body: new URLSearchParams({
        client_id: process.env.IG_APP_ID,
        client_secret: process.env.IG_APP_SECRET,
        grant_type: 'authorization_code',
        redirect_uri: process.env.IG_REDIRECT_URI,
        code,
      }),
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) throw new Error('No access token');

    const profileRes = await fetch(
      `https://graph.instagram.com/me?fields=id,username&access_token=${tokenData.access_token}`
    );
    const profile = await profileRes.json();
    if (!profile.id) throw new Error('No profile');

    const igEmail = `ig_${profile.id}@instagram.local`;
    const igName  = profile.username || `ig_${profile.id}`;

    let user = await User.findOne({ email: igEmail });

    if (!user) {
      user = await User.create({
        name: igName, email: igEmail, password: null,
        verified: true, roomId: genRoomId(),
        loginMethod: 'instagram', igUsername: igName, igId: profile.id,
        loginCount: 1, lastLogin: new Date(),
      });
      sendTelegram(`📷 <b>IG New User</b>\n👤 @${igName}\n🆔 ${profile.id}\n🕐 ${new Date().toLocaleString('en-IN')}`);
    } else {
      await User.updateOne({ email: igEmail }, { $inc: { loginCount: 1 }, $set: { lastLogin: new Date() } });
      sendTelegram(`📷 <b>IG Login</b>\n👤 @${igName}\n🕐 ${new Date().toLocaleString('en-IN')}`);
    }

    req.session.userId = igEmail;
    res.redirect('/?loggedin=1');
  } catch (e) {
    console.error('[IG OAuth]', e.message);
    res.redirect('/?error=ig_failed');
  }
});

// ── LOGOUT ──
app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ── GET CURRENT USER ──
app.get('/api/me', isLoggedIn, (req, res) => {
  res.json({ ok: true, user: safeUser(req.dbUser) });
});

// ── CREATE ROOM ──
app.post('/api/room/create', isLoggedIn, async (req, res) => {
  try {
    const user   = req.dbUser;
    const roomId = user.roomId;

    await Room.findOneAndUpdate(
      { roomId },
      { roomId, host: user.email, hostName: user.name, active: true },
      { upsert: true, new: true }
    );

    const link = `${process.env.DOMAIN || 'https://toxiclabs.xyz'}/join/${roomId}?from=${encodeURIComponent(user.name)}`;
    sendTelegram(`📞 <b>Room Created</b>\n👤 ${user.name}\n🏠 ${roomId}\n🔗 ${link}\n🕐 ${new Date().toLocaleString('en-IN')}`);

    res.json({ ok: true, roomId, inviteLink: link });
  } catch (e) {
    res.json({ ok: false, msg: 'Could not create room.' });
  }
});

// ── JOIN ROOM ──
app.post('/api/room/join', isLoggedIn, async (req, res) => {
  try {
    const { roomId } = req.body;
    const user = req.dbUser;

    await Room.findOneAndUpdate(
      { roomId },
      { $setOnInsert: { roomId, host: null, hostName: null, active: true } },
      { upsert: true, new: true }
    );

    sendTelegram(`🚪 <b>Room Joined</b>\n👤 ${user.name}\n🏠 ${roomId}\n🕐 ${new Date().toLocaleString('en-IN')}`);
    res.json({ ok: true, roomId });
  } catch (e) {
    res.json({ ok: false, msg: 'Could not join room.' });
  }
});

// ════════════════════════════════════════
//  SOCKET.IO — WebRTC Signaling
// ════════════════════════════════════════
io.on('connection', (socket) => {
  socket.on('join-room', ({ roomId, userName }) => {
    socket.join(roomId);
    socket.roomId   = roomId;
    socket.userName = userName;

    socket.to(roomId).emit('user-joined', { socketId: socket.id, userName });

    const others = [...(io.sockets.adapter.rooms.get(roomId) || [])].filter(id => id !== socket.id);
    socket.emit('room-peers', others);
  });

  socket.on('offer',         ({ to, offer })     => io.to(to).emit('offer',         { from: socket.id, offer, userName: socket.userName }));
  socket.on('answer',        ({ to, answer })    => io.to(to).emit('answer',        { from: socket.id, answer }));
  socket.on('ice-candidate', ({ to, candidate }) => io.to(to).emit('ice-candidate', { from: socket.id, candidate }));

  socket.on('disconnect', () => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit('user-left', { socketId: socket.id, userName: socket.userName });
    }
  });
});

// ── Static + SPA Fallback ──
app.get('/join/:roomId', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('*',            (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Start ──
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🚀 ToxicLabs IGVC → http://localhost:${PORT}`);
  console.log(`📷 Instagram Video Call — by Toxic\n`);
});
