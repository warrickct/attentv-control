// PM2 ecosystem file for production deployment
module.exports = {
  apps: [{
    name: 'attentv-control',
    script: 'server.ts',
    interpreter: 'tsx',
    instances: 1,
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      PORT: 3001,
      HOST: '0.0.0.0',
      AWS_PROFILE: process.env.AWS_PROFILE || 'iotdevice',  // Alternative: 'attentv-terraform'
      AWS_REGION: process.env.AWS_REGION || 'ap-southeast-2'
    },
    error_file: './logs/err.log',
    out_file: './logs/out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    autorestart: true,
    watch: false,
    max_memory_restart: '1G'
  }]
}

