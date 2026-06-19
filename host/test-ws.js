import WebSocket from 'ws';

const ws = new WebSocket('ws://localhost:8000/_next/webpack-hmr', {
  headers: {
    Cookie: 'portable_token=Geervan123',
    Referer: 'http://localhost:8000/gateway/web-forge-hackathon/port/3000/'
  }
});

ws.on('open', () => {
  console.log('WS CONNECTION SUCCESSFUL!');
  ws.close();
});

ws.on('error', (err) => {
  console.error('WS CONNECTION FAILED:', err.message);
});
