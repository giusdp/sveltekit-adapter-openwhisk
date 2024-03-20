import { RouteDefinition } from '@sveltejs/kit';

export function get_default_runtime() {
    const major = process.version.slice(1).split('.')[0];
    if (major === '18') return 'nodejs18.x';
    if (major === '20') return 'nodejs20.x';

    throw new Error(
        `Unsupported Node.js version: ${process.version}. Please use Node 18 or Node 20 to build your project, or explicitly specify a runtime in your adapter configuration.`
    );
}

export function get_pathname(route: RouteDefinition<any>) {
    let i = 1;

    const pathname = route.segments
        .map((segment) => {
            if (!segment.dynamic) {
                return '/' + segment.content;
            }

            const parts = segment.content.split(/\[(.+?)\](?!\])/);
            let result = '';

            if (
                parts.length === 3 &&
                !parts[0] &&
                !parts[2] &&
                (parts[1].startsWith('...') || parts[1][0] === '[')
            ) {
                // Special case: segment is a single optional or rest parameter.
                // In that case we don't prepend a slash (also see comment in pattern_to_src).
                result = `$${i++}`;
            } else {
                result =
                    '/' +
                    parts
                        .map((content, j) => {
                            if (j % 2) {
                                return `$${i++}`;
                            } else {
                                return content;
                            }
                        })
                        .join('');
            }

            return result;
        })
        .join('');

    return pathname[0] === '/' ? pathname.slice(1) : pathname;
}

/**
 * Adjusts the stringified route regex for Vercel's routing system
 * @param {string} pattern stringified route regex
 */
export function pattern_to_src(pattern: string) {
    let src = pattern
        // remove leading / and trailing $/
        .slice(1, -2)
        // replace escaped \/ with /
        .replace(/\\\//g, '/');

    // replace the root route "^/" with "^/?"
    if (src === '^/') {
        src = '^/?';
    }

    // Move non-capturing groups that swallow slashes into their following capturing groups.
    // This is necessary because during ISR we're using the regex to construct the __pathname
    // query parameter: In case of a route like [required]/[...rest] we need to turn them
    // into $1$2 and not $1/$2, because if [...rest] is empty, we don't want to have a trailing
    // slash in the __pathname query parameter which wasn't there in the original URL, as that
    // could result in a false trailing slash redirect in the SvelteKit runtime, leading to infinite redirects.
    src = src.replace(/\(\?:\/\((.+?)\)\)/g, '(/$1)');

    return src;
}
