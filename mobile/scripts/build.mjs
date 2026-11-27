/**
 * Builds the mobile app for one edition.
 *
 *   node scripts/build.mjs prepare [--edition <folder>]
 *       checks the edition, writes generated/ (edition, server list, Android resources),
 *       builds shell and chat page with Vite into www/ and copies them into the Android
 *       project (cap sync).
 *   node scripts/build.mjs apk [--edition <folder>]
 *       prepare, then a debug APK in dist/<appId>-debug.apk
 *   node scripts/build.mjs apk-release [--edition <folder>]
 *       prepare, then a signed APK to pass around in dist/<appId>-<version>.apk
 *   node scripts/build.mjs aab [--edition <folder>]
 *       prepare, then the signed App Bundle for Google Play in dist/<appId>-<version>.aab
 *
 * apk-release and aab need android/keystore.properties, see docs/mobile.md.
 *
 * The edition folder defaults to mobile/edition, STARCHAT_EDITION or --edition pick another
 * one. --dev (or STARCHAT_DEV=1) builds the development app: id <appId>.dev and name
 * "<appName> Dev", so it installs next to the released one. The version comes from
 * STARCHAT_VERSION (a tag like v1.2.3 is fine, development builds use 0.0.0-dev.<number>)
 * or mobile/package.json. Paths to JDK, Android SDK and Gradle cache can be set in
 * build.local.json (not in git) instead of the environment.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { NO_START_SCRIPT } from '../../desktop/chat/edition-start.mjs';
import { androidResources, loadEdition, runtimeEdition, serverListForBuild, VERSION_PATTERN, versionCode } from './edition.mjs';

const mobileDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const generatedDir = path.join(mobileDir, 'generated');
const wwwDir = path.join(mobileDir, 'www');
const androidDir = path.join(mobileDir, 'android');
const isWindows = process.platform === 'win32';

function parseArgs(argv) {
    const [command = 'prepare', ...rest] = argv;
    let edition = process.env.STARCHAT_EDITION || '';
    let dev = ['1', 'true'].includes(String(process.env.STARCHAT_DEV || '').toLowerCase());
    for (let i = 0; i < rest.length; i++) {
        if (rest[i] === '--edition') edition = rest[++i] || '';
        else if (rest[i].startsWith('--edition=')) edition = rest[i].slice('--edition='.length);
        else if (rest[i] === '--dev') dev = true;
    }
    return { command, dev, editionDir: edition ? path.resolve(edition) : path.join(mobileDir, 'edition') };
}

function appVersion(pkg) {
    const fromEnv = String(process.env.STARCHAT_VERSION || '').trim().replace(/^v/, '');
    const version = fromEnv || pkg.version;
    if (!VERSION_PATTERN.test(version)) {
        throw new Error(`Version "${version}" must be x.y.z or x.y.z-dev.<number> (Android needs a number for each build)`);
    }
    return version;
}

function writeFile(file, content) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
}

/** The desktop modules for profiles are CommonJS; Rollup converts them for the shell bundle. */
const sharedDesktopModules = /desktop[\\/](connections|edition)\.js$|desktop[\\/]html[\\/]shared[\\/]connection\.js$/;

async function buildPage(name, outDir) {
    await build({
        configFile: false,
        root: path.join(mobileDir, name),
        // Served by Capacitor from https://localhost/, relative URLs keep both pages movable
        base: './',
        publicDir: false,
        logLevel: 'warn',
        resolve: {
            alias: { crypto: path.join(mobileDir, 'shell', 'crypto-shim.mjs') },
        },
        build: {
            outDir,
            emptyOutDir: true,
            chunkSizeWarningLimit: 1500,
            commonjsOptions: {
                include: [/node_modules/, sharedDesktopModules],
                // Only read by the desktop app itself, never called from the shell
                ignore: ['./generated/edition.json', './generated/servers.json'],
            },
            assetsInlineLimit: (filePath) => (filePath.endsWith('.worklet.js') ? false : undefined),
        },
    });
}

function runCapacitor(args) {
    const cli = path.join(mobileDir, 'node_modules', '@capacitor', 'cli', 'bin', 'capacitor');
    if (!existsSync(cli)) throw new Error('Capacitor is not installed. Run "npm install" in mobile/ first.');
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: mobileDir, stdio: 'inherit' });
    if (result.status !== 0) throw new Error(`cap ${args.join(' ')} failed`);
}

async function prepare(editionDir, dev) {
    const pkg = JSON.parse(readFileSync(path.join(mobileDir, 'package.json'), 'utf8'));
    const version = appVersion(pkg);
    const { edition, files } = loadEdition(editionDir, { dev });
    console.log(`Edition "${edition.appName}" (${edition.appId}) ${version} from ${editionDir}`);

    rmSync(generatedDir, { recursive: true, force: true });
    mkdirSync(generatedDir, { recursive: true });

    writeFile(path.join(generatedDir, 'edition.json'), `${JSON.stringify(runtimeEdition(edition, version), null, 4)}\n`);
    copyFileSync(files.icon, path.join(generatedDir, 'icon.png'));
    writeFile(
        path.join(generatedDir, 'edition-theme.css'),
        files['chat.themeCss'] ? readFileSync(files['chat.themeCss'], 'utf8') : '/* no theme of the edition */\n',
    );
    writeFile(
        path.join(generatedDir, 'edition-start.mjs'),
        files['chat.startScript'] ? readFileSync(files['chat.startScript'], 'utf8') : NO_START_SCRIPT,
    );
    const serverList = await serverListForBuild(edition);
    writeFile(path.join(generatedDir, 'servers.json'), `${JSON.stringify(serverList || { schemaVersion: 1, servers: [] }, null, 4)}\n`);
    if (serverList) console.log(`Bundled server list with ${serverList.servers.length} servers`);

    writeFile(path.join(generatedDir, 'android.json'), `${JSON.stringify({
        applicationId: edition.appId,
        versionName: version,
        versionCode: versionCode(version),
        nativeApi: pkg.starchat?.nativeApi || 1,
    }, null, 4)}\n`);
    for (const [relative, content] of Object.entries(androidResources(edition, files))) {
        const target = path.join(generatedDir, 'android-res', relative);
        if (typeof content === 'string') {
            writeFile(target, content);
        } else {
            mkdirSync(path.dirname(target), { recursive: true });
            copyFileSync(content.copy, target);
        }
    }
    const googleServices = path.join(androidDir, 'app', 'google-services.json');
    if (files['push.googleServices']) copyFileSync(files['push.googleServices'], googleServices);
    else rmSync(googleServices, { force: true });

    writeFile(path.join(mobileDir, 'capacitor.config.json'), `${JSON.stringify({
        appId: edition.appId,
        appName: edition.appName,
        webDir: 'www',
        backgroundColor: edition.splashBackground || '#1e1f22',
        // WebView debugging stays at Capacitor's default: on in debug builds, off in release builds
        android: { allowMixedContent: false, captureInput: false },
        plugins: { SystemBars: { insetsHandling: 'native' } },
    }, null, 4)}\n`);

    await buildPage('shell', wwwDir);
    await buildPage('chat', path.join(wwwDir, 'chat'));
    runCapacitor(['sync', 'android']);
    console.log('Prepared generated/ and www/, Android project synced');
}

/** JDK, Android SDK and Gradle cache from build.local.json, else from the environment. */
function gradleEnvironment() {
    const localFile = path.join(mobileDir, 'build.local.json');
    const local = existsSync(localFile) ? JSON.parse(readFileSync(localFile, 'utf8')) : {};
    const env = { ...process.env };
    if (local.javaHome) env.JAVA_HOME = local.javaHome;
    if (local.androidHome) env.ANDROID_HOME = local.androidHome;
    if (local.gradleUserHome) env.GRADLE_USER_HOME = local.gradleUserHome;
    if (!env.JAVA_HOME) throw new Error('JAVA_HOME missing: set it or add "javaHome" to mobile/build.local.json');
    return env;
}

export function runGradle(task) {
    // Absolute path: cmd.exe does not find gradlew.bat through the working directory on mapped drives
    const gradlew = path.join(androidDir, isWindows ? 'gradlew.bat' : 'gradlew');
    const result = spawnSync(isWindows ? `"${gradlew}"` : gradlew, [task, '--console=plain'], {
        cwd: androidDir,
        env: gradleEnvironment(),
        stdio: 'inherit',
        shell: isWindows,
    });
    // A gradlew without execute bit (checked in on Windows) fails before printing anything
    if (result.error) throw new Error(`Gradle ${task} could not start: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`Gradle ${task} failed`);
}

const PACKAGES = {
    apk: { task: 'assembleDebug', from: 'app/build/outputs/apk/debug/app-debug.apk', name: (android) => `${android.applicationId}-debug.apk` },
    'apk-release': { task: 'assembleRelease', signed: true, from: 'app/build/outputs/apk/release/app-release.apk', name: (android) => `${android.applicationId}-${android.versionName}.apk` },
    aab: { task: 'bundleRelease', signed: true, from: 'app/build/outputs/bundle/release/app-release.aab', name: (android) => `${android.applicationId}-${android.versionName}.aab` },
};

function packageApp(command) {
    const output = PACKAGES[command];
    if (output.signed && !existsSync(path.join(androidDir, 'keystore.properties'))) {
        throw new Error('Signing key missing: create mobile/android/keystore.properties (see docs/mobile.md).');
    }
    runGradle(output.task);
    const android = JSON.parse(readFileSync(path.join(generatedDir, 'android.json'), 'utf8'));
    const target = path.join(mobileDir, 'dist', output.name(android));
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(androidDir, output.from), target);
    console.log(`\n${command === 'aab' ? 'App Bundle' : 'APK'} ${android.versionName}: ${target}`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const { command, dev, editionDir } = parseArgs(process.argv.slice(2));
    if (command !== 'prepare' && !PACKAGES[command]) {
        console.error(`Unknown command "${command}". Use prepare, apk, apk-release or aab.`);
        process.exit(1);
    }
    try {
        await prepare(editionDir, dev);
        if (command !== 'prepare') packageApp(command);
    } catch (error) {
        console.error(error.message);
        process.exit(1);
    }
}
