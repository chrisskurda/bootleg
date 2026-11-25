// Libraries: named sets of music sources, each with a mode that decides which fields and tools the app offers.
//   listening — music you listen to: ratings, memories, provenance of the recording.
//   studio    — music you make: status, takes/versions, to-dos, mix notes, how it was recorded.
// A mode is a set of defaults, not a wall: notes, ratings and tags belong to the *recording* and are shared across libraries.
export const MODES = {
  listening: { label: 'Listening', noteKinds: [['note', 'Note'], ['memory', 'Memory'], ['story', 'Story']], provenance: ['vinyl-rip', 'cd-rip', 'mix-cd-rip', 'live-recording', 'digital-purchase', 'streaming', 'other'], status: false },
  studio: { label: 'Studio', noteKinds: [['note', 'Note'], ['idea', 'Idea'], ['todo', 'To-do'], ['mix', 'Mix note'], ['version', 'Version / take']], provenance: ['studio-recording', 'mixdown', 'demo', 'rehearsal', 'stem-render', 'other'], status: true },
};
export const STATUSES = ['idea', 'draft', 'mixing', 'mastered', 'released'];
const uid = () => 'l' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

export class Libraries {
  constructor(store) {
    this.store = store; let d = store.get('libraries', null);
    if (!d || !Array.isArray(d.list) || !d.list.length) d = { active: 'music', list: [{ id: 'music', name: 'Music', mode: 'listening', roots: store.get('roots', []), connections: [] }] };   // migrates the single-library roots of v0.1/0.2
    for (const l of d.list) l.connections ||= [];
    this.d = d; this._save();
  }
  _save() { this.store.set('libraries', this.d); }
  get list() { return this.d.list; } get active() { return this.d.active; }
  get(id) { return this.d.list.find(l => l.id === id) || null; }
  setActive(id) { this.d.active = id === 'all' || this.get(id) ? id : this.d.list[0].id; this._save(); }
  target() { return this.get(this.d.active) || this.d.list[0]; }           // where "Add folder" goes
  add(name, mode = 'listening') { const l = { id: uid(), name: name.trim() || 'Library', mode: MODES[mode] ? mode : 'listening', roots: [], connections: [] }; this.d.list.push(l); this._save(); return l; }
  update(id, patch) { const l = this.get(id); if (!l) return; if (patch.name != null) l.name = patch.name.trim() || l.name; if (patch.mode && MODES[patch.mode]) l.mode = patch.mode; this._save(); }
  remove(id) { if (this.d.list.length < 2) return false; this.d.list = this.d.list.filter(l => l.id !== id); if (this.d.active === id) this.d.active = this.d.list[0].id; this._save(); return true; }
  addRoot(id, root) { const l = this.get(id); if (l && !l.roots.includes(root)) { l.roots.push(root); this._save(); } }
  removeRoot(id, root) { const l = this.get(id); if (l) { l.roots = l.roots.filter(r => r !== root); this._save(); } }
  // Source-plugin connections (Subsonic, …): { id, plugin, title, config } — config never holds a plain password.
  addConnection(id, conn) { const l = this.get(id); if (l) { l.connections.push(conn); this._save(); } }
  removeConnection(id, connId) { const l = this.get(id); if (l) { l.connections = l.connections.filter(c => c.id !== connId); this._save(); } }
  allConnections() { return this.d.list.flatMap(l => l.connections.map(conn => ({ conn, lib: l }))); }
  connection(connId) { return this.allConnections().find(x => x.conn.id === connId)?.conn || null; }
  ofRoot(root) { return this.d.list.find(l => l.roots.includes(root) || l.connections.some(c => `${c.plugin}:${c.id}` === root)) || null; }
  allRoots() { return this.d.list.flatMap(l => l.roots.map(root => ({ root, lib: l }))); }
  // The mode that applies to an item: the active library's if it is in it, else the first library it belongs to.
  modeOf(item) { const ids = item?.libs ? [...item.libs] : []; const l = (this.d.active !== 'all' && ids.includes(this.d.active) ? this.get(this.d.active) : ids.map(i => this.get(i)).find(Boolean)) || this.target(); return l.mode; }
}
