#!/bin/bash
# SmartPay Dashboard — Deploy Script
# Run this on your VPS

set -e

echo "==> Installing dependencies..."
npm install

echo "==> Opening port 3000 on firewall..."
ufw allow 3000
ufw reload

echo "==> Starting server (dashboard + attlog poller run together)..."
node server.js
