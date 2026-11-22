/**
 * Runs a Gradle task in android/ with the paths from build.local.json, for example the
 * Java unit tests: node scripts/gradle.mjs testDebugUnitTest. Needs a prepared build
 * (npm run prepare:app), Gradle reads generated/android.json.
 */
import { runGradle } from './build.mjs';

const task = process.argv[2];
if (!task) {
    console.error('Usage: node scripts/gradle.mjs <task>');
    process.exit(1);
}
try {
    runGradle(task);
} catch (error) {
    console.error(error.message);
    process.exit(1);
}
