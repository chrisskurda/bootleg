// Built-in source plugins. Add yours here (or call registerSource from anywhere before the app starts).
import { registerSource } from './plugin.js';
import { subsonic } from './subsonic.js';
import { stemserver } from './stemserver.js';
registerSource(subsonic);
registerSource(stemserver);
export { getSource, listSources } from './plugin.js';
