/**
 * Edition of the mobile app: name, id, icons, servers, texts and push, fixed at build time.
 * A fork or another repository keeps its own edition folder and builds with
 * `--edition <folder>` or STARCHAT_EDITION=<folder>. See docs/mobile.md.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { pngSize } from '../../desktop/scripts/edition.mjs';

export { serverListForBuild } from '../../desktop/scripts/edition.mjs';

const schemaPath = new URL('../edition.schema.json', import.meta.url);

function readJson(file) {
    // Editors on Windows like to save with a BOM, which JSON.parse rejects
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

const DEFAULT_GOOGLE_SERVICES = 'google-services.json';

/** Files of an edition, relative to its folder. Paths must stay inside the folder. */
function referencedFiles(edition) {
    return [
        { key: 'icon', file: edition.icon },
        { key: 'adaptiveIcon.foreground', file: edition.adaptiveIcon?.foreground },
        { key: 'chat.themeCss', file: edition.chat?.themeCss },
        { key: 'chat.startScript', file: edition.chat?.startScript },
        { key: 'push.googleServices', file: edition.push?.googleServices },
    ].filter(entry => entry.file);
}

/**
 * Reads and checks an edition folder.
 *
 * @param {string} dir
 * @param {{ dev?: boolean }} [options] dev: the development build, see devVariant()
 * @return {{ edition: Object, files: Object<string, string> }} files: key -> absolute path
 */
export function loadEdition(dir, { dev = false } = {}) {
    const file = path.join(dir, 'edition.json');
    if (!existsSync(file)) {
        throw new Error(`No edition.json in ${dir}`);
    }
    const edition = readJson(file);
    // The Firebase file is kept out of git: when it lies in the folder, it counts as named
    if (!edition.push?.googleServices && existsSync(path.join(dir, DEFAULT_GOOGLE_SERVICES))) {
        edition.push = { ...edition.push, googleServices: DEFAULT_GOOGLE_SERVICES };
    }
    const validate = new Ajv2020({ allErrors: true }).compile(readJson(schemaPath));
    if (!validate(edition)) {
        const problems = validate.errors.map(error => `  ${error.instancePath || '/'} ${error.message}`);
        throw new Error(`${file} is not valid:\n${problems.join('\n')}`);
    }

    if (dev) Object.assign(edition, devVariant(edition));

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
    const size = pngSize(files.icon);
    if (!size || size.width < 512 || size.width !== size.height) {
        throw new Error(`icon: ${edition.icon} must be a square PNG of at least 512x512 pixels${size ? ` (is ${size.width}x${size.height})` : ''}`);
    }
    if (files['push.googleServices']) checkGoogleServices(files['push.googleServices'], edition.appId);
    return { edition, files };
}

/**
 * Firebase only delivers to the app the file was made for: a wrong package name would
 * build fine and then fail at the first push.
 */
function checkGoogleServices(file, appId) {
    let data;
    try {
        data = readJson(file);
    } catch {
        throw new Error('push.googleServices is not valid JSON');
    }
    const packages = (data?.client || []).map(client => client?.client_info?.android_client_info?.package_name);
    if (!packages.includes(appId)) {
        throw new Error(`push.googleServices has no Android app with the package name ${appId} (found: ${packages.filter(Boolean).join(', ') || 'none'})`);
    }
}

/**
 * Id and name of the development build: it installs next to the released app instead of
 * replacing it, and is told apart in the launcher.
 */
export function devVariant(edition) {
    return {
        appId: edition.devAppId || `${edition.appId}.dev`,
        appName: `${edition.appName.slice(0, 26).trim()} Dev`,
    };
}

/** Versions the build accepts: 1.2.3, or 0.0.0-dev.<build number> for development builds. */
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(-dev\.\d+)?$/;

/**
 * 1.2.3 -> 10203. Google Play takes every versionCode only once. Development builds count
 * with their build number, so every new one installs over the one before.
 */
export function versionCode(version) {
    const dev = /^\d+\.\d+\.\d+-dev\.(\d+)$/.exec(version);
    if (dev) return Number(dev[1]);
    const [major, minor, patch] = version.split('.').map(Number);
    if (minor > 99 || patch > 99) throw new Error(`Version ${version}: minor and patch must stay below 100`);
    return major * 10000 + minor * 100 + patch;
}

/**
 * What the shell and the chat read at runtime (generated/edition.json, bundled into both).
 *
 * @param {Object} edition
 * @param {string} version
 */
export function runtimeEdition(edition, version) {
    return {
        appName: edition.appName,
        appId: edition.appId,
        version,
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
        // Without the Firebase file there is no FCM token, so no push at all
        push: Boolean(edition.push?.googleServices),
        pushGateway: edition.push?.googleServices ? (edition.push.gateway || '').replace(/\/+$/, '') : '',
    };
}

function escapeXml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '\\"').replace(/'/g, "\\'");
}

/**
 * Android resources of the edition (generated/android-res), as { relative path: content }.
 * Binary files are given as { copy: absolute source path }.
 *
 * @param {Object} edition
 * @param {Object<string, string>} files from loadEdition()
 */
export function androidResources(edition, files) {
    const background = edition.adaptiveIcon?.background || '#ffffff';
    const splash = edition.splashBackground || background;
    const resources = {
        'values/edition.xml': `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <string name="app_name">${escapeXml(edition.appName)}</string>
    <string name="title_activity_main">${escapeXml(edition.appName)}</string>
    <string name="package_name">${edition.appId}</string>
    <string name="custom_url_scheme">${edition.appId}</string>
    <color name="ic_launcher_background">${background}</color>
    <color name="splash_background">${splash}</color>
</resources>
`,
        'drawable-nodpi/edition_icon.png': { copy: files.icon },
        // Android 7 has no adaptive icons: the full icon
        'mipmap-nodpi/ic_launcher.png': { copy: files.icon },
        'mipmap-nodpi/ic_launcher_round.png': { copy: files.icon },
        'drawable/splash.xml': `<?xml version="1.0" encoding="utf-8"?>
<layer-list xmlns:android="http://schemas.android.com/apk/res/android">
    <item android:drawable="@color/splash_background" />
    <item android:width="128dp" android:height="128dp" android:gravity="center" android:drawable="@drawable/edition_icon" />
</layer-list>
`,
    };

    let foreground;
    const source = files['adaptiveIcon.foreground'];
    if (source?.endsWith('.xml')) {
        resources['drawable/ic_launcher_foreground.xml'] = readFileSync(source, 'utf8');
        foreground = '@drawable/ic_launcher_foreground';
    } else if (source) {
        resources['drawable-nodpi/ic_launcher_foreground.png'] = { copy: source };
        foreground = '@drawable/ic_launcher_foreground';
    } else {
        // The whole icon inside the safe zone of the adaptive mask
        resources['drawable/ic_launcher_foreground.xml'] = `<?xml version="1.0" encoding="utf-8"?>
<inset xmlns:android="http://schemas.android.com/apk/res/android" android:drawable="@drawable/edition_icon" android:inset="22%" />
`;
        foreground = '@drawable/ic_launcher_foreground';
    }
    const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="${foreground}" />
</adaptive-icon>
`;
    resources['mipmap-anydpi-v26/ic_launcher.xml'] = adaptive;
    resources['mipmap-anydpi-v26/ic_launcher_round.xml'] = adaptive;
    return resources;
}
