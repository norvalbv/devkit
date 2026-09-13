import domain from 'node:domain';
import LruCache from './lru-cache.js';
export function createRequestHandlers(ports) {
    const { request, badge, getBadgeData, log, analytics, makeSend, queryString } = ports;
    'use strict';
    const minAccuracy = 0.75;
    const freqRatioMax = 1 - minAccuracy;
    const requestCache = new LruCache(1000);
    const vendorDomain = domain.create();
    vendorDomain.on('error', err => {
        log.error('Vendor hook error:', err.stack);
    });
    const globalQueryParams = new Set([
        'label',
        'style',
        'link',
        'logo',
        'logoWidth',
        'link',
        'colorA',
        'colorB',
    ]);
    function flattenQueryParams(queryParams) {
        const union = new Set(globalQueryParams);
        (queryParams || []).forEach(name => {
            union.add(name);
        });
        return Array.from(union).sort();
    }
    function handleRequest(handlerOptions) {
        if (typeof handlerOptions === 'function') {
            handlerOptions = { handler: handlerOptions };
        }
        const allowedKeys = flattenQueryParams(handlerOptions.queryParams);
        return (queryParams, match, end, ask) => {
            if (queryParams.maxAge !== undefined && /^[0-9]+$/.test(queryParams.maxAge)) {
                ask.res.setHeader('Cache-Control', 'max-age=' + queryParams.maxAge);
            }
            else {
                ask.res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            }
            const reqTime = new Date();
            const date = reqTime.toGMTString();
            ask.res.setHeader('Expires', date);
            ask.res.setHeader('Date', date);
            analytics.noteRequest(queryParams, match);
            const filteredQueryParams = {};
            allowedKeys.forEach(key => {
                filteredQueryParams[key] = queryParams[key];
            });
            const stringified = queryString.stringify(filteredQueryParams);
            const cacheIndex = `${match[0]}?${stringified}`;
            const cached = requestCache.get(cacheIndex);
            let cachedVersionSent = false;
            if (cached !== undefined) {
                const tooSoon = (+reqTime - cached.time) < cached.interval;
                if (tooSoon || (cached.dataChange / cached.reqs <= freqRatioMax)) {
                    badge(cached.data.badgeData, makeSend(cached.data.format, ask.res, end));
                    cachedVersionSent = true;
                    if (tooSoon) {
                        return;
                    }
                }
            }
            let serverUnresponsive = false;
            const serverResponsive = setTimeout(() => {
                serverUnresponsive = true;
                if (cachedVersionSent) {
                    return;
                }
                if (requestCache.has(cacheIndex)) {
                    const cached = requestCache.get(cacheIndex).data;
                    badge(cached.badgeData, makeSend(cached.format, ask.res, end));
                    return;
                }
                ask.res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                const badgeData = getBadgeData('vendor', filteredQueryParams);
                badgeData.text[1] = 'unresponsive';
                let extension;
                try {
                    extension = match[0].split('.').pop();
                }
                catch (e) {
                    extension = 'svg';
                }
                badge(badgeData, makeSend(extension, ask.res, end));
            }, 25000);
            let cacheInterval = 5000;
            function cachingRequest(uri, options, callback) {
                if ((typeof options === 'function') && !callback) {
                    callback = options;
                }
                if (options && typeof options === 'object') {
                    options.uri = uri;
                }
                else if (typeof uri === 'string') {
                    options = { uri: uri };
                }
                else {
                    options = uri;
                }
                options.headers = options.headers || {};
                options.headers['User-Agent'] = options.headers['User-Agent'] || 'Shields.io';
                request(options, (err, res, body) => {
                    if (res != null && res.headers != null) {
                        const cacheControl = res.headers['cache-control'];
                        if (cacheControl != null) {
                            const age = cacheControl.match(/max-age=([0-9]+)/);
                            if (age != null && (+age[1] === +age[1])) {
                                cacheInterval = +age[1] * 1000;
                            }
                        }
                    }
                    callback(err, res, body);
                });
            }
            vendorDomain.run(() => {
                handlerOptions.handler(filteredQueryParams, match, function sendBadge(format, badgeData) {
                    if (serverUnresponsive) {
                        return;
                    }
                    clearTimeout(serverResponsive);
                    let dataHasChanged = false;
                    if (cached !== undefined
                        && cached.data.badgeData.text[1] !== badgeData.text[1]) {
                        dataHasChanged = true;
                    }
                    badgeData.format = format;
                    const updatedCache = {
                        reqs: cached ? (cached.reqs + 1) : 1,
                        dataChange: cached ? (cached.dataChange + (dataHasChanged ? 1 : 0))
                            : 1,
                        time: +reqTime,
                        interval: cacheInterval,
                        data: { format: format, badgeData: badgeData }
                    };
                    requestCache.set(cacheIndex, updatedCache);
                    if (!cachedVersionSent) {
                        badge(badgeData, makeSend(format, ask.res, end));
                    }
                }, cachingRequest);
            });
        };
    }
    function clearRequestCache() {
        requestCache.clear();
    }
    return { handleRequest, clearRequestCache };
}
