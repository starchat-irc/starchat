/**
 * Builds the desktop app for one edition.
 *
 *   node scripts/build.mjs prepare [--edition <folder>]
 *       checks the edition and writes generated/: edition.json, icons, the chat page
 *       (Vite) and the electron-builder settings.
 *   node scripts/build.mjs dist [--edition <folder>] [electron-builder options]
 *       prepare, then the installers in dist/ (e.g. --win, --linux, --mac, --dir).
 *
 * The edition folder defaults to desktop/edition, STARCHAT_EDITION or --edition pick
 * another one. The version comes from STARCHAT_VERSION (a tag like v1.2.3 is fine) or
 * desktop/package.json.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { NO_START_SCRIPT } from '../chat/edition-start.mjs';
import { builderConfig, loadEdition, runtimeEdition, serverListForBuild } from './edition.mjs';

const desktopDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const buildDir = path.join(desktopDir, 'generated');

function parseArgs(argv) {
    const [command = 'prepare', ...rest] = argv;
    const passThrough = [];
    let edition = process.env.STARCHAT_EDITION || '';
    for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--edition') {
            edition = rest[++i] || '';
        } else if (rest[i].startsWith('--edition=')) {
            edition = rest[i].slice('--edition='.length);
        } else {
            passThrough.push(rest[i]);
        }
    }
    return {
        command,
        editionDir: edition ? path.resolve(edition) : path.join(desktopDir, 'edition'),
        passThrough,
    };
}

function appVersion(pkg) {
    const fromEnv = String(process.env.STARCHAT_VERSION || '').trim().replace(/^v/, '');
    const version = fromEnv || pkg.version;
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
        throw new Error(`Version "${version}" is not semver (x.y.z)`);
    }
    return version;
}

async function buildChatPage() {
    await build({
        configFile: false,
        root: path.join(desktopDir, 'chat'),
        // Loaded via file://, so every URL in the output must be relative
        base: './',
        publicDir: false,
        logLevel: 'warn',
        build: {
            outDir: path.join(buildDir, 'chat'),
            emptyOutDir: true,
            chunkSizeWarningLimit: 1500,
            // AudioWorklets must stay files: the CSP of the chat page blocks data: modules
            assetsInlineLimit: (filePath) => (filePath.endsWith('.worklet.js') ? false : undefined),
        },
    });
}

async function prepare(editionDir) {
    const pkg = JSON.parse(readFileSync(path.join(desktopDir, 'package.json'), 'utf8'));
    const version = appVersion(pkg);
    const { edition, files } = loadEdition(editionDir);
    console.log(`Edition "${edition.appName}" (${edition.appId}) ${version} from ${editionDir}`);

    rmSync(buildDir, { recursive: true, force: true });
    mkdirSync(buildDir, { recursive: true });

    const runtime = runtimeEdition(edition, version);
    copyFileSync(files.icon, path.join(buildDir, 'icon.png'));
    if (files.splashImage) copyFileSync(files.splashImage, path.join(buildDir, runtime.splashImage));
    if (files['chatBundles.publicKey']) copyFileSync(files['chatBundles.publicKey'], path.join(buildDir, 'chat-bundle-key.pem'));
    writeFileSync(
        path.join(buildDir, 'edition-theme.css'),
        files['chat.themeCss'] ? readFileSync(files['chat.themeCss'], 'utf8') : '/* no theme of the edition */\n',
    );
    writeFileSync(
        path.join(buildDir, 'edition-start.mjs'),
        files['chat.startScript'] ? readFileSync(files['chat.startScript'], 'utf8') : NO_START_SCRIPT,
    );
    writeFileSync(path.join(buildDir, 'edition.json'), `${JSON.stringify(runtime, null, 4)}\n`);
    // Directory without network and cache; the app loads newer versions of the list itself
    const serverList = await serverListForBuild(edition);
    if (serverList) {
        writeFileSync(path.join(buildDir, 'servers.json'), `${JSON.stringify(serverList, null, 4)}\n`);
        console.log(`Bundled server list with ${serverList.servers.length} servers`);
    }
    writeFileSync(path.join(buildDir, 'electron-builder.json'), `${JSON.stringify(builderConfig(pkg.build, edition, version), null, 4)}\n`);

    await buildChatPage();
    // Signed chat updates older than the chat inside the app are never installed (chat-bundles.js)
    writeFileSync(path.join(buildDir, 'chat', 'build.json'), JSON.stringify({ builtAt: Date.now() }));
    console.log('Prepared generated/ (edition, icons, chat page, electron-builder settings)');
}

function dist(passThrough) {
    const cli = path.join(desktopDir, 'node_modules', 'electron-builder', 'cli.js');
    const result = spawnSync(process.execPath, [cli, '--config', path.join('generated', 'electron-builder.json'), ...passThrough], {
        cwd: desktopDir,
        stdio: 'inherit',
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
}

const { command, editionDir, passThrough } = parseArgs(process.argv.slice(2));
if (command !== 'prepare' && command !== 'dist') {
    console.error(`Unknown command "${command}". Use prepare or dist.`);
    process.exit(1);
}
try {
    await prepare(editionDir);
    if (command === 'dist') dist(passThrough);
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
