// Built-in output plugins. Add yours here (or call registerOutput before the app starts).
import { registerOutput } from './plugin.js';
import { dlna } from './dlna.js';
registerOutput(dlna);
export { getOutput, listOutputs } from './plugin.js';
