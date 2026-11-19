/**
 * Feature modules. A module is only active when it is loaded here and the server
 * offers the feature of the same name in its discovery file (hasFeature()). Client
 * modules without a server feature (share) are checked with hasModule().
 */
import { profilesModule } from './profiles.js';
import { friendsModule } from './friends.js';
import { uploadsModule } from './uploads.js';
import { gifsModule } from './gifs.js';
import { reportsModule } from './reports.js';
import { exploreModule } from './explore.js';
import { shareModule } from './share.js';
import { chatStateModule } from './chat-state.js';
import { alwaysOnModule } from './always-on.js';
import { eventsModule } from './events.js';
import { pushModule } from './push.js';
import { voiceModule } from './voice.js';
import { callsModule } from './calls.js';
import { communitiesModule } from './communities.js';

/**
 * @typedef {Object} ChatModule
 * @property {string} name Feature name from docs/discovery.md.
 * @property {() => Object} [mixin] Methods and state added to the chat component.
 * @property {(registry: Object) => void} [register] Registers settings (settingsRegistry).
 * @property {Object<string, Function>} [hooks] Called with the component as `this`
 *   (settingsSectionOpened, settingsSectionClosed, registered after every IRC
 *   registration, connecting after the socket was opened, loggedOut, exploreTabOpened
 *   with the tab name, init when the component starts, loggingOut before the socket closes,
 *   pageHide when the page is closed, before the QUIT, communityChanged with the id of the
 *   community shown or null for Home).
 */

export {
    profilesModule, friendsModule, uploadsModule, gifsModule, reportsModule, exploreModule, shareModule,
    chatStateModule, alwaysOnModule, eventsModule, pushModule, voiceModule, callsModule, communitiesModule,
};

/** Loaded by mountChat() unless the edition passes its own list. */
export const defaultModules = [
    profilesModule, friendsModule, uploadsModule, gifsModule, reportsModule, exploreModule, shareModule,
    chatStateModule, alwaysOnModule, eventsModule, pushModule, voiceModule, callsModule, communitiesModule,
];
