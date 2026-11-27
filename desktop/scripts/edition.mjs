/**
 * Edition of the desktop app: name, ids, icons, servers and texts, fixed at build time.
 * A fork or another repository keeps its own edition folder and builds with
 * `--edition <folder>` or STARCHAT_EDITION=<folder>. See docs/desktop.md.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';

const schemaPath = new URL('../edition.schema.json', import.meta.url);

function readJson(file) {
    // Editors on Windows like to save with a BOM, which JSON.parse rejects
    return JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
}

/**
 * Files of an edition, relative to its folder. Paths must stay inside the folder.
 *
 * @param {Object} edition
 * @return {{ key: string, file: string }[]}
 */
function referencedFiles(edition) {
    return [
        { key: 'icon', file: edition.icon },
        { key: 'splashImage', file: edition.splashImage },
        { key: 'chat.themeCss', file: edition.chat?.themeCss },
        { key: 'chat.startScript', file: edition.chat?.startScript },
        { key: 'chatBundles.publicKey', file: edition.chatBundles?.publicKey },
    ].filter(entry => entry.file);
}

/** Width and height of a PNG file, or null when it is no PNG. */
export function pngSize(file) {
    const header = readFileSync(file).subarray(0, 24);
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (header.length < 24 || !header.subarray(0, 8).equals(signature)) return null;
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

/**
 * Reads and checks an edition folder.
 *
 * @param {string} dir
 * @return {{ edition: Object, files: Object<string, string> }} files: key -> absolute path
 */
export function loadEdition(dir) {
    const file = path.join(dir, 'edition.json');
    if (!existsSync(file)) {
        throw new Error(`No edition.json in ${dir}`);
    }
    const edition = readJson(file);
    const validate = new Ajv2020({ allErrors: true }).compile(readJson(schemaPath));
    if (!validate(edition)) {
        const problems = validate.errors.map(error => `  ${error.instancePath || '/'} ${error.message}`);
        throw new Error(`${file} is not valid:\n${problems.join('\n')}`);
    }

    const root = path.resolve(dir);
    const files = {};
    for (const { key, file: relative } of referencedFiles(edition)) {
        const absolute = path.resolve(root, relative);
        if (!absolute.startsWith(root + path.sep)) {
            throw new Error(`${key}: ${relative} is outside the edition folder`);
        }
        if (!existsSync(absolute)) {
            throw new Error(`${key}: ${relative} does not exist`);
        }
        files[key] = absolute;
    }
    // electron-builder needs a square icon of at least 512 pixels for macOS
    const size = pngSize(files.icon);
    if (!size || size.width < 512 || size.width !== size.height) {
        throw new Error(`icon: ${edition.icon} must be a square PNG of at least 512x512 pixels${size ? ` (is ${size.width}x${size.height})` : ''}`);
    }
    return { edition, files };
}

/**
 * What the app reads at runtime (generated/edition.json inside the package). File paths are
 * replaced by the names the build gives them.
 *
 * @param {Object} edition
 * @param {string} version
 */
export function runtimeEdition(edition, version) {
    return {
        appName: edition.appName,
        appId: edition.appId,
        executableName: edition.executableName,
        dataDir: edition.dataDir || edition.executableName,
        formerDataDirs: edition.formerDataDirs || [],
        version,
        splashImage: edition.splashImage ? `splash${path.extname(edition.splashImage)}` : 'icon.png',
        chat: {
            primaryServer: edition.chat.primaryServer || '',
            networkName: edition.chat.primaryServer ? (edition.chat.networkName || edition.chat.primaryServer) : '',
            serverList: edition.chat.serverList ?? 'default',
            defaultChannel: edition.chat.defaultChannel || '',
            theme: edition.chat.theme || 'auto',
            modules: edition.chat.modules || null,
            ctcpVersion: edition.chat.ctcpVersion || '',
            defaultQuitMessage: edition.chat.defaultQuitMessage || '',
        },
        texts: edition.texts || {},
        updates: edition.updates || null,
        chatBundles: edition.chatBundles ? { manifestUrl: edition.chatBundles.manifestUrl } : null,
    };
}

/** Public list in this repository, bundled for editions with serverList 'default'. */
export const REPO_SERVER_LIST = new URL('../../servers/servers.json', import.meta.url);

/** Whether data looks like a server list (format of servers/servers.json). */
export function isServerList(data) {
    return Boolean(data) && data.schemaVersion === 1 && Array.isArray(data.servers) && data.servers.length > 0;
}

/**
 * The server list shipped with the app: the public list of this checkout, the own list of
 * the edition (downloaded at build time), or null for serverList false. A list that cannot
 * be loaded is a build error: the app would start with an empty directory without network.
 *
 * @param {Object} edition
 * @param {{ fetchImpl?: typeof fetch, readRepoList?: () => string }} [options]
 */
export async function serverListForBuild(edition, {
    fetchImpl = globalThis.fetch,
    readRepoList = () => readFileSync(REPO_SERVER_LIST, 'utf8'),
} = {}) {
    const source = edition.chat?.serverList ?? 'default';
    if (source === false) return null;
    let data;
    if (source === 'default') {
        data = JSON.parse(readRepoList().replace(/^\uFEFF/, ''));
    } else {
        const response = await fetchImpl(source, { headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`chat.serverList: ${source} answered HTTP ${response.status}`);
        data = await response.json();
    }
    if (!isServerList(data)) throw new Error(`chat.serverList: ${source === 'default' ? 'servers/servers.json' : source} is not a server list`);
    return data;
}

/**
 * electron-builder settings: the static part from package.json ("build") with the
 * values of the edition on top.
 *
 * @param {Object} base package.json → build
 * @param {Object} edition
 * @param {string} version
 */
export function builderConfig(base, edition, version) {
    const name = edition.executableName;
    const config = structuredClone(base);
    config.appId = edition.appId;
    config.productName = edition.appName;
    config.icon = 'generated/icon.png';
    config.copyright = edition.publisher ? `Copyright © ${edition.publisher}` : undefined;
    config.extraMetadata = { ...(config.extraMetadata || {}), name, productName: edition.appName, version };
    config.win = { ...(config.win || {}), icon: 'generated/icon.png' };
    config.linux = { ...(config.linux || {}), icon: 'generated/icon.png', executableName: name };
    config.mac = { ...(config.mac || {}), icon: 'generated/icon.png' };
    config.nsis = { ...(config.nsis || {}), artifactName: `${name}-setup-\${version}.\${ext}` };
    config.linux.artifactName = `${name}-\${version}-\${arch}.\${ext}`;
    config.mac.artifactName = `${name}-\${version}-\${arch}.\${ext}`;
    config.publish = edition.updates ? [{ ...edition.updates }] : null;
    if (edition.publisher) config.linux.maintainer = edition.publisher;
    if (!config.copyright) delete config.copyright;
    return config;
}
