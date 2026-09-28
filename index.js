import express from 'express';
import http from 'node:http';
import { Server } from 'socket.io';

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 3000;

app.get('/search', async (request, response) => {
    const query = typeof request.query.q === 'string' ? request.query.q.trim() : '';

    if (!query || query.length > 200) {
        return response.status(400).send('Enter a search term up to 200 characters.');
    }

    const searchUrl = new URL('https://html.duckduckgo.com/html/');
    searchUrl.searchParams.set('q', query);

    try {
        const upstream = await fetch(searchUrl, {
            signal: AbortSignal.timeout(10000),
        });

        if (!upstream.ok) {
            return response.status(502).send('The search provider could not complete the request.');
        }

        response.type('html').send(await upstream.text());
    } catch {
        response.status(502).send('The search provider is unavailable. Please try again.');
    }
});

app.use(express.static('public'));

io.on('connection', (socket) => {
    console.log('A user connected');
    socket.emit('server:message', 'Realtime connection established.');

    socket.on('disconnect', (reason) => {
        console.log(`A user disconnected: ${reason}`);
    });
});

server.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});
