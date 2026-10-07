const connectionStatus = document.querySelector('#connection-status');
const serverMessage = document.querySelector('#server-message');
const visitList = document.querySelector('#visit-list');
const historyMenu = document.querySelector('#history-menu');
const historyCount = document.querySelector('#history-count');
const proxiedFrame = document.querySelector('iframe[name="search-results"]');
const searchForm = document.querySelector('.search-bar');
const frameExpandButton = document.querySelector('#frame-expand');
const socket = io();
let recentVisits = [];

function renderVisits(visits) {
  recentVisits = visits;
  historyCount.textContent = String(visits.length);
  visitList.replaceChildren();

  if (!visits.length) {
    const emptyMessage = document.createElement('li');
    emptyMessage.className = 'empty-history';
    emptyMessage.textContent = 'No websites visited yet.';
    visitList.append(emptyMessage);
    return;
  }

  for (const visit of visits) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    const hostname = document.createElement('strong');
    const time = document.createElement('time');

    link.href = `/proxy?url=${encodeURIComponent(visit.url)}`;
    link.target = 'search-results';
    link.title = visit.url;
    link.addEventListener('click', () => {
      historyMenu.open = false;
    });
    hostname.textContent = visit.hostname;
    time.dateTime = visit.visitedAt;
    time.textContent = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    }).format(new Date(visit.visitedAt));
    link.append(hostname, time);
    item.append(link);
    visitList.append(item);
  }
}

frameExpandButton.addEventListener('click', () => {
  const expanded = document.body.classList.toggle('frame-expanded');
  frameExpandButton.setAttribute('aria-expanded', String(expanded));
  frameExpandButton.textContent = expanded ? 'Restore' : 'Expand';
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && document.body.classList.contains('frame-expanded')) {
    document.body.classList.remove('frame-expanded');
    frameExpandButton.setAttribute('aria-expanded', 'false');
    frameExpandButton.textContent = 'Expand';
  }
});

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