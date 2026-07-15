module.exports = {
  apps: [
    {
      name: "ai-session-ingestor",
      script: "dist/server.js",
      cwd: __dirname,
      interpreter: "node",
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      env: {
        NODE_ENV: "production",
        HOST: "0.0.0.0",
        AUTO_SYNC: "true",
      },
    },
  ],
};
