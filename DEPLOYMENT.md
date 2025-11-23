# Deployment Guide - VPS Hosting

## Why Host on VPS?

✅ **Leverage existing VPS access control** - No need to set up project-specific credentials  
✅ **AWS credentials already on VPS** - Use existing `attentv-terraform` profile  
✅ **Simple for small team** - Just 3 people, VPS handles authentication  
✅ **Better security** - VPS already has firewall, SSH keys, etc.

---

## Quick Setup (Recommended for Small Team)

### On VPS:

1. **Clone/upload the project:**
   ```bash
   cd /opt  # or wherever you keep projects
   git clone https://github.com/warrickct/attentv-control.git
   cd attentv-control
   npm install
   ```

2. **Verify AWS credentials:**
   ```bash
   # Make sure AWS profile is configured
   aws configure list --profile attentv-terraform
   # Or check ~/.aws/credentials
   ```

3. **Build the frontend:**
   ```bash
   npm run build
   ```

4. **Start with PM2:**
   ```bash
   npm run pm2:start
   npm run pm2:save
   npm run pm2:startup  # Auto-start on reboot (run the command it outputs)
   ```
   
   Or use the all-in-one deploy command:
   ```bash
   npm run deploy
   npm run pm2:startup  # Then run the command it outputs
   ```

6. **Access the app:**
   - Direct: `http://<vps-ip>:3001`
   - Or set up nginx reverse proxy (see below)

**That's it!** The VPS's existing access control (SSH keys, firewall, etc.) handles authentication.

---

## Option 1: Direct Access (Simplest)

Just run the app and access via `http://<vps-ip>:3001`

**Pros:** Quick, no extra setup  
**Cons:** Must remember port number

---

## Option 2: Nginx Reverse Proxy (Recommended)

If you already have nginx on your VPS (or want a cleaner URL):

1. **Follow steps 1-5 above**

2. **Create nginx config** (`/etc/nginx/sites-available/attentv-control`):
   ```nginx
   server {
       listen 80;
       server_name <your-domain>;  # or VPS IP

       location / {
           proxy_pass http://localhost:3001;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_cache_bypass $http_upgrade;
       }
   }
   ```

3. **Enable and restart:**
   ```bash
   sudo ln -s /etc/nginx/sites-available/attentv-control /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl restart nginx
   ```

4. **Access:** `http://<your-domain>` or `http://<vps-ip>`

**Benefits:**
- Clean URL (no `:3001`)
- Easy to add HTTPS later with Let's Encrypt
- Can add basic auth if needed

---

## Security (VPS Already Handles This)

Since you're using VPS access control:

✅ **SSH keys** - Only authorized users can access VPS  
✅ **Firewall** - VPS firewall already configured  
✅ **No project credentials needed** - VPS handles authentication

**Optional additions:**
- **HTTPS:** Use Let's Encrypt (`certbot`) if accessing over internet
- **Basic Auth:** Add to nginx if you want extra layer
- **IP Whitelisting:** Restrict nginx to specific IPs if needed

---

---

## Environment Variables

The `ecosystem.config.js` already has these configured:
- `NODE_ENV=production`
- `PORT=3001`
- `HOST=0.0.0.0` (accessible from network)
- `AWS_PROFILE=attentv-terraform`
- `AWS_REGION=ap-southeast-2`

**No `.env` file needed** - PM2 config handles it.

---

## Quick Start Commands

```bash
# Build and start (all-in-one)
npm run deploy

# Or step by step:
npm run build
npm run pm2:start
npm run pm2:save

# Check status
npm run pm2:status

# View logs
npm run pm2:logs

# Stop
npm run pm2:stop

# Restart (after code changes)
npm run pm2:restart

# Update code and redeploy
git pull
npm install  # if dependencies changed
npm run build
npm run pm2:restart
```

---

## Updating the App

When you make changes:

```bash
# On VPS
cd /opt/attentv-control  # or wherever you cloned it
git pull
npm install  # if dependencies changed
npm run build
npm run pm2:restart
```

---

## Troubleshooting

**Check if app is running:**
```bash
npm run pm2:status
npm run pm2:logs
```

**Check AWS credentials:**
```bash
aws sts get-caller-identity --profile attentv-terraform
```

**Check if port is accessible:**
```bash
curl http://localhost:3001/api/health
```

**View nginx logs:**
```bash
sudo tail -f /var/log/nginx/error.log
```

