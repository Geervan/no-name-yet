import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:3000/_next/webpack-hmr');

ws.on('open', () => {
  console.log('DIRECT WS CONNECTION SUCCESSFUL!');
  ws.close();
});

ws.on('error', (err) => {
  console.error('DIRECT WS CONNECTION FAILED:', err.message);
});
