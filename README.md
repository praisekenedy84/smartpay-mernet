# SmartPay Dashboard

Attendance monitoring dashboard for HIKCentral → PostgreSQL pipeline.

## Stack
- Node.js + Express (API)
- PostgreSQL 15 (Docker)
- Vanilla HTML/CSS/JS (Dashboard)

## Setup on VPS

```bash
# 1. Upload this folder to your VPS
scp -r smartpay-dashboard root@<your-vps-host>:/opt/

# 2. SSH into VPS
ssh root@<your-vps-host>

# 3. Install Node.js if not present
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# 4. Go to project folder
cd /opt/smartpay-dashboard

# 5. Install dependencies
npm install

# 6. Open port 3000
ufw allow 3000
ufw reload

# 7. Start (foreground, for testing)
node server.js

# 8. Run as background service (production)
npm install -g pm2
pm2 start server.js --name smartpay
pm2 save
pm2 startup
```


## API Endpoints
- GET  /api/attendance/live         — Today's events (auto-refreshes every 10s)
- GET  /api/attendance/summary?date=YYYY-MM-DD  — Daily per-employee summary
- GET  /api/stats                   — Today's counts
- GET  /api/admin/shifts            — Shift config (admin)
- PUT  /api/admin/shifts/:id        — Update shift windows (admin)
- GET  /api/admin/employees         — Employee list (admin)
- POST /api/admin/employees         — Add/update employee (admin)
