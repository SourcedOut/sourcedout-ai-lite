module.exports = {
  apps: [{
    name: 'vite',
    script: 'sh',
    args: '-c "npm run dev -- --port 3000 --host 0.0.0.0"',
    cwd: '/app',
    autorestart: true,
    watch: false,
    max_memory_restart: '1G',
    env: {
      NODE_ENV: 'development'
    }
  }]
};