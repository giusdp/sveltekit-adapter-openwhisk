import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeFileTrace } from '@vercel/nft';
import { get_pathname, pattern_to_src, get_default_runtime } from './utils.js';
import { Adapter, Builder, RouteDefinition, VERSION } from '@sveltejs/kit';

export type ImageFormat = 'image/avif' | 'image/webp';

export type RemotePattern = {
    protocol?: 'http' | 'https';
    hostname: string;
    port?: string;
    pathname?: string;
};

export type ImagesConfig = {
    sizes: number[];
    domains: string[];
    remotePatterns?: RemotePattern[];
    minimumCacheTTL?: number; // seconds
    formats?: ImageFormat[];
    dangerouslyAllowSVG?: boolean;
    contentSecurityPolicy?: string;
    contentDispositionType?: string;
};

export interface ServerlessConfig {
	/**
     * base url of the website, it will trying to get from BASE_URL environment variable during runtime when not set.
     */
    baseUrl?: string;

    /**
     * whether to log some debug info, it will trying to get from DEBUG environment variable during runtime when not set.
     * @default true
     */
    debug?: boolean;
    /**
     * header to get user's ip, it will trying to get from IP_HEADER environment variable during runtime when not set.
     * @default 'x-forwarded-proto'
     */
    ipHeader?: string;
    /**
     * Which version of node to use (`'nodejs18.x'`, `'nodejs20.x'` etc).
     * @default 'nodejs18.x'
     */
    runtime?: `nodejs${number}.x`;
    /**
     * Maximum execution duration (in seconds) that will be allowed for the Serverless Function.
     */
    maxDuration?: number;
    /**
     * Amount of memory (RAM in MB) that will be allocated to the Serverless Function.
     */
    memory?: number;
    /**
     * If `true`, this route will always be deployed as its own separate function
     */
    split?: boolean;

    /**
     * https://vercel.com/docs/build-output-api/v3/configuration#images
     */
    images?: ImagesConfig;
}

const name = '@giusdp/sveltekit-adapter-openwhisk';
const DEFAULT_FUNCTION_NAME = 'fn';

function adapter(defaults: ServerlessConfig): Adapter {
    return {
        name,

        async adapt(builder: Builder) {
            // builder.writeServer(tmp);

            // writeFileSync(
            // 	`${tmp}/manifest.js`,
            // 	`export const manifest = ${builder.generateManifest({ relativePath: './' })};\n\n` +
            // 	`export const prerendered = new Set(${JSON.stringify(
            // 		builder.prerendered.paths
            // 	)});\n`
            // );

            // const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

            // // we bundle the Vite output so that deployments only need
            // // their production dependencies. Anything in devDependencies
            // // will get included in the bundled code
            // const bundle = await rollup({
            // 	input: {
            // 		index: `${tmp}/index.js`,
            // 		manifest: `${tmp}/manifest.js`
            // 	},
            // 	external: [
            // 		// dependencies could have deep exports, so we need a regex
            // 		...Object.keys(pkg.dependencies || {}).map((d) => new RegExp(`^${d}(\\/.*)?$`))
            // 	],
            // 	plugins: [
            // 		nodeResolve({
            // 			preferBuiltins: true,
            // 			exportConditions: ['node']
            // 		}),
            // 		commonjs({ strictRequires: true }),
            // 		json()
            // 	]
            // });

            // await bundle.write({
            // 	dir: `${out}/server`,
            // 	format: 'esm',
            // 	sourcemap: true,
            // 	chunkFileNames: `chunks/[name]-[hash].js`
            // });

            // builder.copy(files, out, {
            // 	replace: {
            // 		MANIFEST: './server/manifest.js',
            // 		SERVER: './server/index.js',
            // 		SHIMS: './shims.js',
            // 		BASE_URL: stringifyOrDefault(baseUrl, `process.env[${JSON.stringify(envPrefix + 'BASE_URL')}]`),
            // 		DEBUG: stringifyOrDefault(debug, `process.env[${JSON.stringify(envPrefix + 'DEBUG')}] === 'true'`),
            // 		IP_HEADER: stringifyOrDefault(
            // 			ipHeader,
            // 			`process.env[${JSON.stringify(envPrefix + 'IP_HEADER')}] ?? 'x-forwarded-for'`
            // 		)
            // 	}
            // });

            // // If polyfills aren't wanted then clear the file
            // if (!polyfill) {
            // 	writeFileSync(`${out}/shims.js`, '', 'utf-8');
            // }

            if (!builder.routes) {
                throw new Error(
                    '@giusdp/sveltekit-adapter-openwhisk requires @sveltejs/kit version 1.5 or higher. Please upgrade @sveltejs/kit'
                );
            }

            const dir = '.ow/output';
            const tmp = builder.getBuildDirectory('ow-tmp');

            builder.rimraf(dir);
            builder.rimraf(tmp);

            const files = fileURLToPath(new URL('./files', import.meta.url).href);

            const dirs = {
                static: `${dir}/static${builder.config.kit.paths.base}`,
                functions: `${dir}/functions`
            };

            builder.log.minor('Copying assets...');

            builder.writeClient(dirs.static);
            builder.writePrerendered(dirs.static);

            const static_config = static_vercel_config(builder, defaults, dirs.static);

            builder.log.minor('Generating serverless function...');

            async function generate_serverless_function(
                name: string,
                config: ServerlessConfig,
                routes: RouteDefinition<ServerlessConfig>[]
            ) {
                const dir = `${dirs.functions}/${name}.func`;

                const relativePath = path.posix.relative(tmp, builder.getServerDirectory());

                builder.copy(`${files}/serverless.js`, `${tmp}/index.js`, {
                    replace: {
                        SERVER: `${relativePath}/index.js`,
                        MANIFEST: './manifest.js'
                    }
                });

                write(
                    `${tmp}/manifest.js`,
                    `export const manifest = ${builder.generateManifest({ relativePath, routes })};\n`
                );

                await create_function_bundle(builder, `${tmp}/index.js`, dir, config);

                for (const asset of builder.findServerAssets(routes)) {
                    // TODO use symlinks, once Build Output API supports doing so
                    builder.copy(`${builder.getServerDirectory()}/${asset}`, `${dir}/${asset}`);
                }
            }

            const groups: Map<
                string,
                { i: number; config: ServerlessConfig; routes: RouteDefinition<ServerlessConfig>[] }
            > = new Map();

            const conflicts: Map<string, { hash: string; route_id: string }> = new Map();

            const functions: Map<string, string> = new Map();

            // group routes by config
            for (const route of builder.routes) {
                const runtime = route.config?.runtime ?? defaults?.runtime ?? get_default_runtime();
                const config = { runtime, ...defaults, ...route.config };

                if (is_prerendered(route)) {
                    continue;
                }

                const node_runtime = /nodejs([0-9]+)\.x/.exec(runtime);
                if (!node_runtime || parseInt(node_runtime[1]) < 18) {
                    throw new Error(
                        `Invalid runtime '${runtime}' for route ${route.id}. Valid runtimes are 'nodejs18.x' or higher ` +
                            '(see the Node.js Version section in your project settings for info on the currently supported versions).'
                    );
                }

                if (config.isr) {
                    const directory = path.relative(
                        '.',
                        builder.config.kit.files.routes + route.id
                    );

                    if (!runtime.startsWith('nodejs')) {
                        throw new Error(
                            `${directory}: Routes using \`isr\` must use a Node.js runtime (for example 'nodejs20.x')`
                        );
                    }

                    if (config.isr.allowQuery?.includes('__pathname')) {
                        throw new Error(
                            `${directory}: \`__pathname\` is a reserved query parameter for \`isr.allowQuery\``
                        );
                    }
                }

                const hash = hash_config(config);

                // first, check there are no routes with incompatible configs that will be merged
                const pattern = route.pattern.toString();
                const existing = conflicts.get(pattern);
                if (existing) {
                    if (existing.hash !== hash) {
                        throw new Error(
                            `The ${route.id} and ${existing.route_id} routes must be merged into a single function that matches the ${route.pattern} regex, but they have incompatible configs. You must either rename one of the routes, or make their configs match.`
                        );
                    }
                } else {
                    conflicts.set(pattern, { hash, route_id: route.id });
                }

                // then, create a group for each config
                const id = config.split ? `${hash}-${groups.size}` : hash;
                let group = groups.get(id);
                if (!group) {
                    group = { i: groups.size, config, routes: [] };
                    groups.set(id, group);
                }

                group.routes.push(route);
            }

            const singular = groups.size === 1;

            for (const group of groups.values()) {
                // generate one function for the group
                const name = singular ? DEFAULT_FUNCTION_NAME : `fn-${group.i}`;

                await generate_serverless_function(
                    name,
                    /** @type {any} */ group.config,
                    /** @type {import('@sveltejs/kit').RouteDefinition<any>[]} */ group.routes
                );

                for (const route of group.routes) {
                    functions.set(route.pattern.toString(), name);
                }
            }

            for (const route of builder.routes) {
                if (is_prerendered(route)) continue;

                const pattern = route.pattern.toString();
                const src = pattern_to_src(pattern);
                const name = functions.get(pattern) ?? 'fn-0';

                if (!singular) {
                    static_config.routes.push({
                        src: src + '(?:/__data.json)?$',
                        dest: `/${name}`
                    });
                }
            }

            if (!singular) {
                // we need to create a catch-all route so that 404s are handled by SvelteKit

                const runtime = defaults.runtime ?? get_default_runtime();

                await generate_serverless_function(
                    DEFAULT_FUNCTION_NAME,
                    /** @type {any} */ { runtime, ...defaults },
                    []
                );
            }

            // Catch-all route must come at the end, otherwise it will swallow all other routes,
            // including ISR aliases if there is only one function
            static_config.routes.push({ src: '/.*', dest: `/${DEFAULT_FUNCTION_NAME}` });

            builder.log.minor('Writing routes...');

            write(`${dir}/config.json`, JSON.stringify(static_config, null, '\t'));
        }
    };
}

function hash_config(config: ServerlessConfig) {
    return [config.runtime ?? '', config.memory ?? '', config.maxDuration ?? ''].join('/');
}

function write(file: string, data: string) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
    } catch {
        // do nothing
    }

    fs.writeFileSync(file, data);
}

// This function is from the vercel adapter, aso duplicated in adapter-static
function static_vercel_config(builder: Builder, config: ServerlessConfig, dir: string) {
    const prerendered_redirects: any[] = [];

    const overrides: Record<string, { path: string }> = {};

    const images = config.images;

    for (const [src, redirect] of builder.prerendered.redirects) {
        prerendered_redirects.push({
            src,
            headers: {
                Location: redirect.location
            },
            status: redirect.status
        });
    }

    for (const [path, page] of builder.prerendered.pages) {
        let overrides_path = path.slice(1);

        if (path !== '/') {
            /** @type {string | undefined} */
            let counterpart_route = path + '/';

            if (path.endsWith('/')) {
                counterpart_route = path.slice(0, -1);
                overrides_path = path.slice(1, -1);
            }

            prerendered_redirects.push(
                { src: path, dest: counterpart_route },
                { src: counterpart_route, status: 308, headers: { Location: path } }
            );
        }

        overrides[page.file] = { path: overrides_path };
    }

    const routes = [
        ...prerendered_redirects,
        {
            src: `/${builder.getAppPath()}/immutable/.+`,
            headers: {
                'cache-control': 'public, immutable, max-age=31536000'
            }
        }
    ];

    // https://vercel.com/docs/deployments/skew-protection
    if (process.env.VERCEL_SKEW_PROTECTION_ENABLED) {
        routes.push({
            src: '/.*',
            has: [
                {
                    type: 'header',
                    key: 'Sec-Fetch-Dest',
                    value: 'document'
                }
            ],
            headers: {
                'Set-Cookie': `__vdpl=${process.env.VERCEL_DEPLOYMENT_ID}; Path=${builder.config.kit.paths.base}/; SameSite=Strict; Secure; HttpOnly`
            },
            continue: true
        });

        // this is a dreadful hack that is necessary until the Vercel Build Output API
        // allows you to set multiple cookies for a single route. essentially, since we
        // know that the entry file will be requested immediately, we can set the second
        // cookie in _that_ response rather than the document response
        const base = `${dir}/${builder.config.kit.appDir}/immutable/entry`;
        const entry = fs.readdirSync(base).find((file) => file.startsWith('start.'));

        if (!entry) {
            throw new Error('Could not find entry point');
        }

        routes.splice(-2, 0, {
            src: `/${builder.getAppPath()}/immutable/entry/${entry}`,
            headers: {
                'Set-Cookie': `__vdpl=; Path=/${builder.getAppPath()}/version.json; SameSite=Strict; Secure; HttpOnly`
            },
            continue: true
        });
    }

    routes.push({
        handle: 'filesystem'
    });

    return {
        version: 3,
        routes,
        overrides,
        images
    };
}

async function create_function_bundle(
    builder: Builder,
    entry: string,
    dir: string,
    config: ServerlessConfig
) {
    fs.rmSync(dir, { force: true, recursive: true });

    let base = entry;
    while (base !== (base = path.dirname(base)));

    const traced = await nodeFileTrace([entry], { base });

    const resolution_failures: Map<string, string[]> = new Map();

    traced.warnings.forEach((error) => {
        // pending https://github.com/vercel/nft/issues/284
        if (error.message.startsWith('Failed to resolve dependency node:')) return;

        // parse errors are likely not js and can safely be ignored,
        // such as this html file in "main" meant for nw instead of node:
        // https://github.com/vercel/nft/issues/311
        if (error.message.startsWith('Failed to parse')) return;

        if (error.message.startsWith('Failed to resolve dependency')) {
            const match = /Cannot find module '(.+?)' loaded from (.+)/;
            const [, module, importer] = match.exec(error.message) ?? [
                ,
                error.message,
                '(unknown)'
            ];

            if (!resolution_failures.has(importer)) {
                resolution_failures.set(importer, []);
            }

            resolution_failures.get(importer)?.push(module);
        } else {
            throw error;
        }
    });

    if (resolution_failures.size > 0) {
        const cwd = process.cwd();
        builder.log.warn(
            'Warning: The following modules failed to locate dependencies that may (or may not) be required for your app to work:'
        );

        for (const [importer, modules] of resolution_failures) {
            console.error(`  ${path.relative(cwd, importer)}`);
            for (const module of modules) {
                console.error(`    - \u001B[1m\u001B[36m${module}\u001B[39m\u001B[22m`);
            }
        }
    }

    const files = Array.from(traced.fileList);

    // find common ancestor directory
    let common_parts: string[] = files[0]?.split(path.sep) ?? [];

    for (let i = 1; i < files.length; i += 1) {
        const file = files[i];
        const parts = file.split(path.sep);

        for (let j = 0; j < common_parts.length; j += 1) {
            if (parts[j] !== common_parts[j]) {
                common_parts = common_parts.slice(0, j);
                break;
            }
        }
    }

    const ancestor = base + common_parts.join(path.sep);

    for (const file of traced.fileList) {
        const source = base + file;
        const dest = path.join(dir, path.relative(ancestor, source));

        const stats = fs.statSync(source);
        const is_dir = stats.isDirectory();

        const realpath = fs.realpathSync(source);

        try {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
        } catch {
            // do nothing
        }

        if (source !== realpath) {
            const realdest = path.join(dir, path.relative(ancestor, realpath));
            fs.symlinkSync(
                path.relative(path.dirname(dest), realdest),
                dest,
                is_dir ? 'dir' : 'file'
            );
        } else if (!is_dir) {
            fs.copyFileSync(source, dest);
        }
    }

    write(
        `${dir}/.ow-config.json`,
        JSON.stringify(
            {
                runtime: config.runtime,
                memory: config.memory,
                maxDuration: config.maxDuration,
                handler: path.relative(base + ancestor, entry),
                launcherType: 'Nodejs',
                framework: {
                    slug: 'sveltekit',
                    version: VERSION
                }
            },
            null,
            '\t'
        )
    );

    write(`${dir}/package.json`, JSON.stringify({ type: 'module' }));
}

function is_prerendered(route: RouteDefinition<any>) {
    return (
        route.prerender === true ||
        (route.prerender === 'auto' && route.segments.every((segment) => !segment.dynamic))
    );
}

export default adapter;
