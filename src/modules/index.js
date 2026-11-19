/**
 * Feature modules. A module is only active when it is loaded here and the server
 * offers the feature of the same name in its discovery file (hasFeature()).
 */
import { profilesModule } from './profiles.js';

/**
 * @typedef {Object} ChatModule
 * @property {string} name Feature name from docs/discovery.md.
 * @property {() => Object} [mixin] Methods and state added to the chat component.
 * @property {(registry: Object) => void} [register] Registers settings (settingsRegistry).
 * @property {Object<string, Function>} [hooks] Called with the component as `this`
 *   (settingsSectionOpened, settingsSectionClosed).
 */

export { profilesModule };

/** Loaded by mountChat() unless the edition passes its own list. */
export const defaultModules = [profilesModule];
