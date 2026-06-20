module.exports = {
  apps: [{
    name: 'screenshot-svc',
    script: 'server.js',
    interpreter: 'node',
    env: { PORT: 3001 },
    watch: false,
    instances: 1,
    exec_mode: 'fork'
  }]
}
