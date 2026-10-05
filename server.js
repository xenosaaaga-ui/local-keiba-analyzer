'use strict';

const { createApp } = require('./src/app');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

createApp().listen(PORT, HOST, () => {
  console.log(`local-keiba-analyzer listening on http://${HOST}:${PORT}`);
});
