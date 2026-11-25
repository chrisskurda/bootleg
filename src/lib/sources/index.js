// Built-in source plugins. Add yours here (or call registerSource from anywhere before the app starts).
import { registerSource } from './plugin.js';
import { subsonic } from './subsonic.js';
registerSource(subsonic);
export { getSource, listSources } from './plugin.js';
