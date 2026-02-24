// PM2 ecosystem file for production deployment
const path = require('path')
const appDir = path.resolve(__dirname)

module.exports = {
  apps: [{
    name: 'attentv-control',
    script: 'server.ts',
    cwd: appDir,
    interpreter: path.join(appDir, 'node_modules', '.bin', 'tsx'),
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      PORT: 3001,
      HOST: '0.0.0.0',
      ...(process.env.AWS_PROFILE && { AWS_PROFILE: process.env.AWS_PROFILE }),
      AWS_REGION: process.env.AWS_REGION || 'ap-southeast-2',
      ...(process.env.SESSION_SECRET && { SESSION_SECRET: process.env.SESSION_SECRET })
    },
    error_file: path.join(appDir, 'logs', 'err.log'),
    out_file: path.join(appDir, 'logs', 'out.log'),
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G'
  }]
}

