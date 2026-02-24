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
   # If using a named profile, set it (optional — defaults to your AWS default profile)
   export AWS_PROFILE=attentv-terraform   # or e.g. iotdevice
   aws configure list --profile "$AWS_PROFILE"
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

6. **Set a session secret (required for login):**
   ```bash
   export SESSION_SECRET="your-random-secret-at-least-32-characters"
   ```
   Use this when starting the app (e.g. in `ecosystem.config.js` or `.env`) so session cookies are signed. Without it, the app still runs but uses a default secret — set a strong value in production.

7. **Access the app:**
   - Direct: `http://<vps-ip>:3001`
   - Or set up nginx reverse proxy (see below)

**That's it!** The app is behind a login screen; users sign in with credentials stored in DynamoDB (see **Login and users table** below).

---

## Login and users table

The app shows a **login page** first; the dashboard is only available after signing in. Users are stored in the DynamoDB table **`attentv-labelling-users`** (or the name set in `LABELLING_USERS_TABLE`).

**Table schema:**

- **Partition key:** `username` (string)
- **Attribute:** `password` (string) — either a **bcrypt hash** (recommended) or plaintext. If the value starts with `$2`, the app treats it as bcrypt and compares with `bcrypt.compare`; otherwise it compares plaintext.

Example item (with bcrypt hash):

```json
{ "username": "jane", "password": "$2b$10$..." }
```

To generate a bcrypt hash for a new user (e.g. in Node):  
`require('bcrypt').hashSync('yourPassword', 10)`.

The EC2 IAM policy in `docs/ec2-attentv-control-iam-policy.json` includes **GetItem** on `attentv-labelling-users` so the app can look up users. Set **`SESSION_SECRET`** in production so session cookies are signed.

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

The `ecosystem.config.js` sets:
- `NODE_ENV=production`
- `PORT=3001`
- `HOST=0.0.0.0` (accessible from network)
- `AWS_REGION=ap-southeast-2` (override with `AWS_REGION` when starting PM2)

**AWS profile** is configurable: set `AWS_PROFILE` in your environment before starting (e.g. `export AWS_PROFILE=attentv-terraform` or `AWS_PROFILE=iotdevice npm run pm2:start`). If unset, the app uses the default AWS credential chain. See `.env.example` for reference.

---

## Deploying to Heroku

The app can run on Heroku. The repo includes a `Procfile` and `heroku-postbuild` so that:

1. **Build**: `npm run build` runs on deploy (frontend is built into `dist/`).
2. **Start**: The web process runs `NODE_ENV=production npx tsx server.ts` (Express serves API + static assets).

**Required config vars** (no `~/.aws` on Heroku — use env vars):

- `AWS_ACCESS_KEY_ID`
- `AWS_SECRET_ACCESS_KEY`
- `AWS_REGION` (e.g. `ap-southeast-2`)

Optional: `DATA_LABELS_TABLE` if your table name differs from the default.

Set them in the Heroku dashboard (Settings → Config Vars) or:

```bash
heroku config:set AWS_ACCESS_KEY_ID=xxx AWS_SECRET_ACCESS_KEY=xxx AWS_REGION=ap-southeast-2
```

Then deploy with the Heroku Git remote or connect GitHub and deploy from there.

---

## Running on EC2 (inside AWS)

On EC2 you should **use an IAM role attached to the instance** (instance profile). The app then gets credentials automatically from the instance metadata — no `~/.aws`, no env vars, and no long‑lived keys on the box.

### 1. Do **not** set AWS credentials on the instance

- Do **not** set `AWS_PROFILE`, `AWS_ACCESS_KEY_ID`, or `AWS_SECRET_ACCESS_KEY` in the app’s environment or in `.env`.
- The app already uses the default credential chain; on EC2 that will pick up the instance profile.

You can set `AWS_REGION` if the default isn’t correct (e.g. `ap-southeast-2`), and `DATA_LABELS_TABLE` if your table name differs.

### 2. Create an IAM role and attach it to the instance

Create an IAM role that EC2 can assume, and give it a policy that allows only what the app needs:

- **DynamoDB**: `Scan`, `Query` on `data_labels` and `attentv-ad-plays-prod`
- **S3**: `ListBucket`, `GetObject` on `attntv`, `attentv-iot-screenshots-prod`, and (for dev) `attentv-iot-screenshots-dev`

A minimal policy is in the repo: **`docs/ec2-attentv-control-iam-policy.json`**. Use it as the role’s policy (or inline policy), then attach the role to your EC2 instance as its **instance profile**. If you set `DATA_LABELS_TABLE` to a different table name, add that table’s ARN to the DynamoDB resources in the policy.

**AWS Console (short version):**

1. IAM → Roles → Create role → Trusted entity: **AWS service** → **EC2** → Next.
2. Attach the policy (create a custom policy from the JSON, or paste it as inline).
3. Name the role (e.g. `attentv-control-ec2`) → Create role.
4. EC2 → Instances → select instance → Actions → Security → **Modify IAM role** → choose that role → Update.

**CLI:** attach the role to the instance profile already associated with the instance, or create an instance profile with that role and attach it to the instance.

After the role is attached, (re)start the app. It will use the instance profile and access DynamoDB and S3 without any credentials in the repo or env.

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

