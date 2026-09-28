const connectionStatus = document.querySelector('#connection-status');
const serverMessage = document.querySelector('#server-message');
const socket = io();

socket.on('connect', () => {
  connectionStatus.textContent = 'Connected';
});

socket.on('disconnect', () => {
  connectionStatus.textContent = 'Disconnected';
});

socket.on('server:message', (message) => {
  serverMessage.textContent = message;
});