import express from 'express';
import http from 'node:http';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Server } from 'socket.io';

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = process.env.PORT || 3000;
const configuredProxyTimeout = Number.parseInt(process.env.PROXY_TIMEOUT_MS ?? '60000', 10);
const proxyTimeoutMs = Number.isSafeInteger(configuredProxyTimeout) && configuredProxyTimeout > 0
    ? configuredProxyTimeout
    : 60000;
const recentVisits = [];
const visitHistoryLimit = 20;
const activityTypes = new Set([
    'search_submitted', 'page_navigation', 'link_clicked', 'control_clicked', 'form_submitted',
]);

function recordWebsiteVisit(destination) {
    const visit = {
        hostname: destination.hostname,
        visitedAt: new Date().toISOString(),
    };
    recentVisits.unshift(visit);
    recentVisits.length = Math.min(recentVisits.length, visitHistoryLimit);
    io.emit('visit:recorded', visit);
}

const blockedAddresses = new BlockList();
[
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
    ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
].forEach(([subnet, prefix]) => blockedAddresses.addSubnet(subnet, prefix, 'ipv4'));
[
    ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
].forEach(([subnet, prefix]) => blockedAddresses.addSubnet(subnet, prefix, 'ipv6'));

function isPublicAddress(address) {
    const family = isIP(address);
    return family !== 0 && !blockedAddresses.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

async function validateDestination(destination) {
    if (!['http:', 'https:'].includes(destination.protocol) || destination.username || destination.password) {
        throw new Error('Only public HTTP and HTTPS addresses are supported.');
    }

    if (destination.hostname === 'localhost' || destination.hostname.endsWith('.localhost')) {
        throw new Error('Local addresses are not supported.');
    }

    const addresses = isIP(destination.hostname)
        ? [{ address: destination.hostname }]
        : await lookup(destination.hostname, { all: true, verbatim: true });

    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
        throw new Error('Private or local network addresses are not supported.');
    }
}

function proxyUrl(destination) {
    return `/proxy?url=${encodeURIComponent(destination.href)}`;
}

function rewriteStylesheet(css, stylesheetUrl) {
    const rewrite = (value) => {
        const url = value.trim();
        if (!url || url.startsWith('#') || /^[a-z][a-z\d+.-]*:/i.test(url) && !/^https?:/i.test(url)) {
            return value;
        }

        try {
            return proxyUrl(new URL(url, stylesheetUrl));
        } catch {
            return value;
        }
    };

    return css
        .replace(/url\(\s*(?:(['"])(.*?)\1|([^)]*?))\s*\)/gi, (match, quote, quoted, unquoted) => {
            const value = quoted ?? unquoted.trim();
            const rewritten = rewrite(value);
            return `url(${quote || ''}${rewritten}${quote || ''})`;
        })
        .replace(/@import\s+(['"])(.*?)\1/gi, (match, quote, value) =>
            `@import ${quote}${rewrite(value)}${quote}`);
}

function rewritePage(html, pageUrl) {
    const rewrite = (value) => {
        if (!value || value.startsWith('#')) return value;
        if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^https?:/i.test(value)) return value;

        try {
            const destination = new URL(value.replaceAll('&amp;', '&'), pageUrl);
            if (destination.hostname === 'duckduckgo.com' && destination.pathname === '/l/') {
                const result = destination.searchParams.get('uddg');
                if (result) return proxyUrl(new URL(result));
            }
            if (!['http:', 'https:'].includes(destination.protocol)) return value;
            return proxyUrl(destination);
        } catch {
            return value;
        }
    };

    const escapedBase = pageUrl.href.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
    const initialUrl = JSON.stringify(pageUrl.href).replaceAll('<', '\\u003c');
    const bridgeScript = `<script>(() => {
        let virtualUrl = new URL(${initialUrl});
        const routeUrls = new Map();
        const localPath = () => location.pathname + location.search + location.hash;
        routeUrls.set(localPath(), virtualUrl.href);

        const proxyLink = (value) => {
            if (!value || value.startsWith('#') || value.startsWith('/proxy?url=')) return value;
            if (/^[a-z][a-z\\d+.-]*:/i.test(value) && !/^https?:/i.test(value)) return value;
            try {
                const destination = new URL(value.replaceAll('&amp;', '&'), virtualUrl);
                if (destination.hostname === 'duckduckgo.com' && destination.pathname === '/l/') {
                    const result = destination.searchParams.get('uddg');
                    if (result) return '/proxy?url=' + encodeURIComponent(new URL(result).href);
                }
                if (!['http:', 'https:'].includes(destination.protocol)) return value;
                return '/proxy?url=' + encodeURIComponent(destination.href);
            } catch {
                return value;
            }
        };

        const rewriteElement = (element) => {
            if (!(element instanceof Element)) return;
            for (const attribute of ['href', 'action', 'src', 'poster']) {
                if (element.hasAttribute(attribute)) {
                    const original = element.getAttribute(attribute);
                    const rewritten = proxyLink(original);
                    if (rewritten !== original) element.setAttribute(attribute, rewritten);
                }
            }
            element.querySelectorAll('[href], [action]').forEach(rewriteElement);
        };

        const reportRoute = () => parent.postMessage({ type: 'proxy:visit', url: virtualUrl.href }, '*');
        const reportActivity = (action, value) => {
            let destination = virtualUrl.href;
            try {
                const candidate = new URL(value || '', location.href);
                const proxiedUrl = candidate.pathname === '/proxy'
                    ? candidate.searchParams.get('url')
                    : null;
                const resolved = new URL(proxiedUrl || candidate.href);
                if (['http:', 'https:'].includes(resolved.protocol)) destination = resolved.href;
            } catch {}
            parent.postMessage({ type: 'proxy:activity', action, url: destination }, '*');
        };
        document.addEventListener('click', (event) => {
            const clicked = event.target instanceof Element
                ? event.target.closest('a[href], button, input[type="button"], input[type="submit"], [role="button"]')
                : null;
            if (!clicked) return;
            const link = clicked.closest('a[href]');
            reportActivity(link ? 'link_clicked' : 'control_clicked', link?.href);
        }, true);
        document.addEventListener('submit', (event) => {
            if (event.target instanceof HTMLFormElement) {
                reportActivity('form_submitted', event.target.action);
            }
        }, true);

        for (const method of ['pushState', 'replaceState']) {
            const original = history[method].bind(history);
            history[method] = function (state, title, url) {
                const result = original(state, title, url);
                if (url != null) {
                    virtualUrl = new URL(url, virtualUrl);
                    routeUrls.set(localPath(), virtualUrl.href);
                    rewriteElement(document.documentElement);
                    reportRoute();
                }
                return result;
            };
        }

        addEventListener('popstate', () => {
            const route = routeUrls.get(localPath());
            if (route) virtualUrl = new URL(route);
            rewriteElement(document.documentElement);
            reportRoute();
        });

        new MutationObserver((changes) => {
            for (const change of changes) {
                if (change.type === 'attributes') rewriteElement(change.target);
                else change.addedNodes.forEach(rewriteElement);
            }
        }).observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['href', 'action', 'src', 'poster'],
        });
        rewriteElement(document.documentElement);
    })();</script>`;
    return html
        .replace(/<meta\b(?=[^>]*\bhttp-equiv\s*=\s*(['"])content-security-policy\1)[^>]*>/gi, '')
        .replace(/<head(\s[^>]*)?>/i, (tag) => `${tag}<base href="${escapedBase}">${bridgeScript}`)
        .replace(/\b(href|action|src|poster)=(['"])(.*?)\2/gi, (attribute, name, quote, value) =>
            `${name}=${quote}${rewrite(value)}${quote}`);
}

app.get('/search', (request, response) => {
    const query = typeof request.query.q === 'string' ? request.query.q.trim() : '';
    if (!query || query.length > 200) {
        return response.status(400).send('Enter a search term or web address up to 200 characters.');
    }

    const isAddress = /^https?:\/\//i.test(query)
        || /^(?:[\w-]+\.)+[\w-]{2,}(?::\d+)?(?:[/?#].*)?$/i.test(query)
        || /^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:[/?#].*)?$/.test(query);
    let destination;
    if (isAddress) {
        destination = new URL(/^https?:\/\//i.test(query) ? query : `https://${query}`);
    } else {
        destination = new URL('https://html.duckduckgo.com/html/');
        destination.searchParams.set('q', query);
    }
    response.redirect(303, proxyUrl(destination));
});

app.get('/proxy', async (request, response) => {
    const rawUrl = typeof request.query.url === 'string' ? request.query.url : '';
    if (!rawUrl || rawUrl.length > 4096) {
        return response.status(400).send('A valid destination address is required.');
    }

    try {
        let destination = new URL(rawUrl);
        for (const [key, value] of Object.entries(request.query)) {
            if (key !== 'url' && typeof value === 'string') destination.searchParams.set(key, value);
        }

        let upstream;
        for (let redirects = 0; redirects <= 5; redirects += 1) {
            await validateDestination(destination);
            upstream = await fetch(destination, {
                redirect: 'manual',
                headers: { 'user-agent': 'Mozilla/5.0 (compatible; WebProxy/1.0)' },
                signal: AbortSignal.timeout(proxyTimeoutMs),
            });

            if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
            const location = upstream.headers.get('location');
            if (!location || redirects === 5) {
                return response.status(502).send('The destination redirected too many times.');
            }
            destination = new URL(location, destination);
        }

        response.status(upstream.status);
        const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
        response.set('content-type', contentType);
        response.set('access-control-allow-origin', '*');
        if (contentType.includes('text/html')) {
            recordWebsiteVisit(destination);
            const html = await upstream.text();
            return response.send(rewritePage(html, destination));
        }
        if (contentType.includes('text/css')) {
            return response.send(rewriteStylesheet(await upstream.text(), destination));
        }
        return response.send(Buffer.from(await upstream.arrayBuffer()));
    } catch (error) {
        const status = error.message.includes('not supported') ? 400 : 502;
        return response.status(status).send(status === 400
            ? error.message
            : 'The destination is unavailable. Please try again.');
    }
});

app.use(express.static('public'));

io.on('connection', (socket) => {
    console.log(JSON.stringify({ event: 'user_connected', socketId: socket.id }));
    socket.emit('server:message', 'Realtime connection established.');
    socket.emit('visits:history', recentVisits);

    socket.on('activity:log', (payload) => {
        if (!payload || typeof payload !== 'object') return;
        const { action, url } = payload;
        if (typeof action !== 'string' || !activityTypes.has(action)) return;

        let targetHost;
        let targetUrl;
        if (typeof url === 'string' && url.length <= 4096) {
            try {
                const destination = new URL(url);
                const proxiedUrl = destination.pathname === '/proxy'
                    ? destination.searchParams.get('url')
                    : null;
                const target = new URL(proxiedUrl || destination.href);
                if (['http:', 'https:'].includes(target.protocol)) {
                    targetHost = target.hostname;
                    targetUrl = target.href;
                }
            } catch {}
        }

        console.log(JSON.stringify({
            event: 'user_activity',
            socketId: socket.id,
            action,
            ...(targetHost ? { targetHost } : {}),
            ...(targetUrl ? { url: targetUrl } : {}),
            occurredAt: new Date().toISOString(),
        }));
    });

    socket.on('visit:page-change', async (rawUrl) => {
        if (typeof rawUrl !== 'string' || rawUrl.length > 4096) return;
        try {
            const destination = new URL(rawUrl);
            await validateDestination(destination);
            recordWebsiteVisit(destination);
        } catch {}
    });

    socket.on('disconnect', (reason) => {
        console.log(JSON.stringify({ event: 'user_disconnected', socketId: socket.id, reason }));
    });
});

server.listen(port, () => {
    console.log(`Server listening on port ${port}`);
});
