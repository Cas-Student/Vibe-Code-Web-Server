const connectionStatus = document.querySelector('#connection-status');
const serverMessage = document.querySelector('#server-message');
const visitList = document.querySelector('#visit-list');
const proxiedFrame = document.querySelector('iframe[name="search-results"]');
const searchForm = document.querySelector('.search-bar');
const socket = io();
let recentVisits = [];

function renderVisits(visits) {
  recentVisits = visits;
  visitList.replaceChildren();

  if (!visits.length) {
    const emptyMessage = document.createElement('li');
    emptyMessage.textContent = 'No websites visited yet.';
    visitList.append(emptyMessage);
    return;
  }

  for (const visit of visits) {
    const item = document.createElement('li');
    const hostname = document.createElement('strong');
    const time = document.createElement('time');

    hostname.textContent = visit.hostname;
    time.dateTime = visit.visitedAt;
    time.textContent = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(visit.visitedAt));
    item.append(hostname, time);
    visitList.append(item);
  }
}

socket.on('connect', () => {
  connectionStatus.textContent = 'Connected';
});

socket.on('disconnect', () => {
  connectionStatus.textContent = 'Disconnected';
});

socket.on('server:message', (message) => {
  serverMessage.textContent = message;
});

socket.on('visits:history', renderVisits);

socket.on('visit:recorded', (visit) => {
  renderVisits([visit, ...recentVisits].slice(0, 20));
});

searchForm.addEventListener('submit', () => {
  socket.emit('activity:log', { action: 'search_submitted' });
});

window.addEventListener('message', (event) => {
  if (event.source !== proxiedFrame.contentWindow || typeof event.data?.url !== 'string') return;

  if (event.data.type === 'proxy:visit') {
    socket.emit('visit:page-change', event.data.url);
    socket.emit('activity:log', { action: 'page_navigation', url: event.data.url });
  } else if (event.data.type === 'proxy:activity'
      && ['link_clicked', 'control_clicked', 'form_submitted'].includes(event.data.action)) {
    socket.emit('activity:log', { action: event.data.action, url: event.data.url });
  }
});