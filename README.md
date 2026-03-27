# 📷 Instagram Video Call — by ToxicLabs

End-to-end encrypted video calling platform with Instagram OAuth, OTP email verification, and real WebRTC peer-to-peer calls.

---

## 🗂 Project Structure

```
igvc/
├── server.js          ← Main backend (Express + Socket.io)
├── package.json       ← Dependencies
├── .env.example       ← Config template → copy to .env
├── data.json          ← Auto-saved user + room data
└── public/
    └── index.html     ← Full frontend (single file)
```

---

## ⚡ Quick Start

### 1. Install dependencies
```bash
cd igvc
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
nano .env   # fill in your values
```

### 3. Run the server
```bash
# Production
npm start

# Development (auto-restart)
npm run dev

# With PM2
pm2 start server.js --name igvc
pm2 save
```

Server runs on → `http://localhost:3000`

---

## 🔧 Configuration (.env)

| Key | What it is |
|-----|-----------|
| `PORT` | Server port (default: 3000) |
| `SESSION_SECRET` | Random secret string for sessions |
| `MAIL_USER` | Your Gmail address |
| `MAIL_PASS` | Gmail **App Password** (not your login password) |
| `TELEGRAM_BOT_TOKEN` | From @BotFather on Telegram |
| `TELEGRAM_CHAT_ID` | Your group/channel ID |
| `IG_APP_ID` | From Meta Developer Console |
| `IG_APP_SECRET` | From Meta Developer Console |
| `IG_REDIRECT_URI` | Must match exactly in Meta console |
| `DOMAIN` | Your domain (e.g. https://toxiclabs.xyz) |

---

## 📧 Gmail App Password Setup
1. Go to Google Account → Security
2. Enable 2-Step Verification
3. Search "App passwords" → Generate one for "Mail"
4. Use that 16-char password as `MAIL_PASS`

---

## 🤖 Telegram Bot Setup
1. Message @BotFather → `/newbot`
2. Copy the token → `TELEGRAM_BOT_TOKEN`
3. Add bot to your group → get chat ID from `https://api.telegram.org/bot<TOKEN>/getUpdates`
4. Use negative ID for groups (e.g. `-1001234567890`)

---

## 📷 Instagram OAuth Setup
1. Go to → https://developers.facebook.com
2. Create new app → Consumer → Instagram Basic Display
3. Add your redirect URI: `https://toxiclabs.xyz/auth/instagram/callback`
4. Copy App ID + Secret → put in `.env`
5. Replace `YOUR_IG_APP_ID` in `public/index.html` line with your actual App ID

---

## 🌐 Deploy on VPS / Toxiclabs.xyz

### With Nginx
```nginx
server {
    listen 80;
    server_name toxiclabs.xyz www.toxiclabs.xyz;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
# SSL with Certbot
sudo certbot --nginx -d toxiclabs.xyz
```

---

## 🔑 Features

- ✅ Instagram OAuth (official Meta API)
- ✅ Email login + registration
- ✅ OTP verification (6-digit, 10 min expiry)
- ✅ Password min. 6 characters with live error
- ✅ Real-time WebRTC video calls
- ✅ Socket.io signaling server
- ✅ Auto invite link per user (`toxiclabs.xyz/invitevc=XXXX`)
- ✅ "{user} invited you" message on join
- ✅ Telegram bot monitoring (login, register, room events)
- ✅ data.json auto-save every 30s
- ✅ Beautiful OTP email template
- ✅ Professional light UI (Instagram style)

---

## 📁 data.json (auto-generated)
Saves all user + room data every 30 seconds:
```json
{
  "users": [...],
  "rooms": [...],
  "savedAt": "2025-..."
}
```

---

Developed by **Toxic** · ToxicLabs.xyz
