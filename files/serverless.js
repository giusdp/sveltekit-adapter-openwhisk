import { installPolyfills } from '@sveltejs/kit/node/polyfills';
import { createReadableStream } from '@sveltejs/kit/node';
import { Server } from 'SERVER';
import { manifest } from 'MANIFEST';

installPolyfills();

const server = new Server(manifest);

await server.init({
    env: /** @type {Record<string, string>} */ (process.env),
    read: createReadableStream
});

const DATA_SUFFIX = '/__data.json';
const baseUrl = BASE_URL;
const ipHeader = IP_HEADER;
const debug = DEBUG;

/**
 * @param {import("./index.js").OpenWhiskRequest} args
 * @returns {Promise<import("./index.js").OpenWhiskResponse>} - the response object
 */
export async function main(args) {
    if (!baseUrl) {
        return {
            statusCode: 500,
            headers: {
                'content-type': 'text/plain'
            },
            body: 'BASE_URL is not set'
        };
    }
    let url = new URL(args.__ow_path, baseUrl);

    if (debug) {
        console.log('args', args);
        console.log('url', url);
    }
    url.search = args.__ow_query;
    const params = new URLSearchParams(args.__ow_query);
    let pathname = params.get('__pathname');
    if (pathname) {
        params.delete('__pathname');
        // Optional routes' pathname replacements look like `/foo/$1/bar` which means we could end up with an url like /foo//bar
        pathname = pathname.replace(/\/+/g, '/');
        url = new URL(`${pathname}${url.href.endsWith(DATA_SUFFIX) ? DATA_SUFFIX : ''}?${params}`);
    }

    const request = new Request(url);

    const response = await server.respond(request, {
        getClientAddress() {
            return args.__ow_headers[ipHeader] ?? 'x-forwarded-for';
        }
    });

    if (debug) {
        console.log('response', response);
    }

    if (response) {
        return {
            statusCode: response.status,
            headers: Object.fromEntries(response.headers),
            body: await response.text()
        };
    }

    return {
        statusCode: 404,
        headers: {
            'content-type': 'text/plain'
        },
        body: 'Not Found'
    };
}
