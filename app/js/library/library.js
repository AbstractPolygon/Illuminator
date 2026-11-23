// The photo library: one folder holding every photo in its own folder, with
// its Lytro Desktop edits, its Illuminator edits and a thumbnail beside it,
// plus library.json listing the photos and the user's albums.
//
//   library.json
//   Photos/IMG_0001/IMG_0001.LFR
//                  /edits.illuminator.json
//                  /thumb.jpg
//   Photos/Beach/raw.lfp            (imported from Lytro Desktop)
//               /stack.view.lfp
//               /stack.userdepthmap.png, .txt   (an edited depth map)
//
// library.json:
// { "format": "illuminator-library", "version": 1,
//   "photos": [{ "id", "name", "file", "sidecar", "thumb", "depthMap", "depthRange", "stack", "size", "photoId", "added", "rating", "flag", "keywords" }],
//   (rating 0-5, flag "pick" or "reject" and keywords are optional: core/marks.js; they are also written to Photos/<id>/<file name>.xmp)
//   "albums": [{ "id", "name", "photos": [photo id, ...] }],
//   "looks": [{ "id", "name" }] }   (each look's settings are in Looks/<id>.json, see core/looks.js)
//
// A photo's id is its folder name. The folder is the truth: photos found in
// Photos/ that library.json does not list are added when the library loads,
// and photos whose folder has gone are dropped.

import { groupPhotos, stem } from './scan.js';
import { normalizeMarks, hasMarks, toXmp } from '../core/marks.js';
import { writeZip, readZip, ARCHIVE_FORMAT, ARCHIVE_VERSION } from './archive.js';

export const LIBRARY_FORMAT = 'illuminator-library';
export const LIBRARY_VERSION = 1;
export const EDITS_FILE = 'edits.illuminator.json';
const INDEX = 'library.json';
// A replacement photo is copied here first and moved into Photos/ only when every file arrived, so a failed copy leaves the old photo whole.
const STAGING = 'Staging';
const PHOTOS = 'Photos';
const LOOKS = 'Looks';
import { PROCESSED_FILE } from '../core/processed-cache.js';
import { STILL_INDEX_FILE, stillFileName, touchIndex, KEPT_INDEX_FILE, KEPT_PICTURES, keptFileName } from '../core/still-cache.js';

const LIGHT_FIELD = /\.(lfr|lfp|raw|lri)$/i;
// A virtual copy's folder holds only its own edits and caches, and this note of which photo it is a copy of: its light field files are the master's.
export const VIRTUAL_FILE = 'virtual.illuminator.json';

function folderName(label) {
  const clean = String(label || 'photo').replace(/[^\w.-]+/g, '_').replace(/^[._]+/, '').slice(0, 60);
  return clean || 'photo';
}

// How many photos an import adds between writes of the index.
const INDEX_SAVE_EVERY = 25;
// And at the latest this long after a change, so a crash in a long import loses seconds of work, not a batch.
const INDEX_SAVE_WITHIN_MS = 5000;

export class Library {
  // store: storage.js backend. readSummary(file) -> { photoId, thumbnail }
  // reads a photo's id and embedded thumbnail ({ mime, bytes } or null).
  constructor(store, { readSummary = async () => ({ photoId: null, thumbnail: null }) } = {}) {
    this.store = store;
    this.readSummary = readSummary;
    this.photos = [];
    this.albums = [];
    this.looks = [];
    this.saving = Promise.resolve();
    this.saveTimer = null;
    // Per-path queues (see serial): read-modify-write of an index file must not interleave.
    this.locks = new Map();
    // Set when library.json could not be read at all and so could not be backed up: it is not overwritten.
    this.indexProtected = false;
  }

  // Runs fn after earlier calls with the same key have finished.
  serial(key, fn) {
    const prev = this.locks.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.locks.set(key, tail);
    tail.then(() => {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    });
    return run;
  }

  // Writes to the folder of a photo that was removed would recreate it.
  isListed(photo) {
    return !!photo && !!this.get(photo.id);
  }

  // Keeps what library.json held before it is replaced by a rebuilt or older-format index; an existing backup is never overwritten.
  async backUpIndex(text) {
    let name = `${INDEX}.bak`;
    if (await this.store.readText(name).catch(() => null) != null) name = `${INDEX}.${Date.now()}.bak`;
    await this.store.writeText(name, text);
    return name;
  }

  get persistent() {
    return this.store.kind !== 'memory';
  }

  async load() {
    let index = null;
    let text = null;
    let problem = null;
    try {
      text = await this.store.readText(INDEX);
    } catch (err) {
      // Could not even read it: nothing to back up, so the file stays as it is.
      console.warn('library.json could not be read; it is left untouched', err);
      this.indexProtected = true;
    }
    if (text) {
      try {
        index = JSON.parse(text);
      } catch (err) {
        problem = 'unreadable';
        console.warn('library.json is unreadable; rebuilding it from the photo folders (a copy is kept as library.json.bak)', err);
      }
    }
    if (index && index.format && index.format !== LIBRARY_FORMAT) index = null;
    if (index && Number(index.version) > LIBRARY_VERSION) {
      problem = 'newer';
      console.warn(`library.json was written by a newer version of Illuminator (format ${index.version}); a copy is kept as library.json.bak`);
    }
    if (problem && text) {
      try {
        this.backup = await this.backUpIndex(text);
      } catch (err) {
        console.warn('Could not back up library.json; it is left untouched', err);
        this.indexProtected = true;
      }
    }
    // Stale staging from a replacement that was interrupted.
    await this.store.remove(STAGING).catch(() => {});
    this.photos = (index && Array.isArray(index.photos) ? index.photos : []).filter((p) => p && p.id && p.file);
    this.albums = (index && Array.isArray(index.albums) ? index.albums : []).filter((a) => a && a.id);
    this.looks = (index && Array.isArray(index.looks) ? index.looks : []).filter((l) => l && l.id);
    const changed = await this.reconcile();
    if (changed || !index) await this.save();
    return this;
  }

  // Brings the list in line with the Photos folder.
  async reconcile() {
    const entries = await this.store.list(PHOTOS);
    const dirs = new Set(entries.filter((e) => e.dir).map((e) => e.name));
    let changed = false;

    let kept = this.photos.filter((p) => dirs.has(p.id));
    // (a virtual copy goes with its master)
    const masters = new Set(kept.filter((p) => !p.master).map((p) => p.id));
    kept = kept.filter((p) => !p.master || masters.has(p.master));
    if (kept.length !== this.photos.length) changed = true;
    this.photos = kept;

    // Folders the index does not know (copied in by hand, or an index lost).
    const lostCopies = [];
    const known = new Set(this.photos.map((p) => p.id));
    for (const dir of dirs) {
      if (known.has(dir)) continue;
      const files = await this.store.list(`${PHOTOS}/${dir}`);
      // A virtual copy whose entry was lost: its note says whose copy it is (read once every photo is listed, so its master is there).
      if (files.some((f) => f.name === VIRTUAL_FILE)) {
        lostCopies.push(dir);
        continue;
      }
      const found = groupPhotos(files.filter((f) => !f.dir).map((f) => ({ path: f.name, file: { name: f.name, size: f.size } })))[0];
      if (!found) continue;
      const thumb = files.find((f) => /^thumb\.(jpe?g|png)$/i.test(f.name));
      // The photo's own id, so that importing it again is still recognized as the same photo (cheap: only the header is read).
      let photoId = null;
      if (/\.(lfr|lfp)$/i.test(found.file.name)) {
        try {
          const f = await this.store.file(`${PHOTOS}/${dir}/${found.file.name}`);
          if (f) photoId = (await this.readSummary(f)).photoId || null;
        } catch {
          // Unreadable: no id, as before.
        }
      }
      this.photos.push({
        id: dir, name: found.name === 'raw' ? dir : found.name, file: found.file.name, sidecar: found.sidecar ? found.sidecar.name : null,
        depthMap: found.depthMap ? found.depthMap.name : null, depthRange: found.depthRange ? found.depthRange.name : null,
        stack: found.stack ? found.stack.name : null,
        thumb: thumb ? thumb.name : null, size: found.file.size, photoId, added: new Date().toISOString(),
      });
      changed = true;
    }

    for (const dir of lostCopies) {
      const note = await this.store.readText(`${PHOTOS}/${dir}/${VIRTUAL_FILE}`).then((t) => JSON.parse(t)).catch(() => null);
      const master = note && this.photos.find((p) => p.id === note.master && !p.master);
      if (!master) continue;
      this.photos.push({ ...this.baseFields(master), id: dir, name: String(note.name || dir), master: master.id, added: note.created || new Date().toISOString() });
      changed = true;
    }

    // Photos left loose in Photos/ (camera imports of earlier versions):
    // each moves into a folder of its own.
    const loose = entries.filter((e) => !e.dir && LIGHT_FIELD.test(e.name));
    if (loose.length) {
      for (const g of groupPhotos(loose.map((e) => ({ path: e.name, file: { name: e.name, size: e.size } })))) {
        const id = this.uniqueId(g.label);
        await this.store.move(`${PHOTOS}/${g.file.name}`, `${PHOTOS}/${id}/${g.file.name}`);
        if (g.sidecar) await this.store.move(`${PHOTOS}/${g.sidecar.name}`, `${PHOTOS}/${id}/${g.sidecar.name}`);
        this.photos.push({ id, name: g.name, file: g.file.name, sidecar: g.sidecar ? g.sidecar.name : null, thumb: null, size: g.file.size, photoId: null, added: new Date().toISOString() });
      }
      changed = true;
    }

    const ids = new Set(this.photos.map((p) => p.id));
    for (const a of this.albums) {
      const inside = (a.photos || []).filter((id) => ids.has(id));
      if (inside.length !== (a.photos || []).length) changed = true;
      a.photos = inside;
    }
    return changed;
  }

  uniqueId(label) {
    const base = folderName(label);
    const taken = new Set(this.photos.map((p) => p.id.toLowerCase()));
    let id = base;
    for (let n = 2; taken.has(id.toLowerCase()); n++) id = `${base}-${n}`;
    return id;
  }

  // Writes the index within a few seconds unless something saves it sooner.
  scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save().catch((err) => console.warn('Could not save the library index', err));
    }, INDEX_SAVE_WITHIN_MS);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  // Everything still waiting is written: called before another library takes the place of this one, so nothing of it lands in that one.
  async close() {
    await this.save();
    await this.saving;
  }

  save() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.indexProtected) return this.saving;
    const doc = { format: LIBRARY_FORMAT, version: LIBRARY_VERSION, photos: this.photos, albums: this.albums, looks: this.looks };
    const text = JSON.stringify(doc, null, 2);
    // One write at a time, in order.
    this.saving = this.saving.catch(() => {}).then(() => this.store.writeText(INDEX, text));
    return this.saving;
  }

  // By id, from a map kept for the list as it is: rebuilt when the list is replaced or changes length (every change to it does one of the two).
  get(id) {
    if (!this.byId || this.byIdFor !== this.photos || this.byIdSize !== this.photos.length) {
      this.byId = new Map(this.photos.map((p) => [p.id, p]));
      this.byIdFor = this.photos;
      this.byIdSize = this.photos.length;
    }
    return this.byId.get(id) || null;
  }

  // Copies photos into the library. entries: [{ name, label, file, sidecar,
  // thumb }] (scan.js). A photo already in the library (same photo id) is
  // not copied again; with `replace`, one with the same name (or photo id)
  // is replaced by the new files, keeping its place in albums, and its
  // edits start over from the new files. Returns the library photo for
  // each entry, in order.
  async add(entries, { onProgress = () => {}, replace = false } = {}) {
    const out = [];
    // The index is written every so many photos and at the end, not after each one: writing it whole each time made a big import cost more with every photo it added.
    let added = 0;
    const changed = () => {
      if (++added % INDEX_SAVE_EVERY) {
        this.scheduleSave();
        return null;
      }
      return this.save();
    };
    try {
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        onProgress(e, i, entries.length);
        let summary = { photoId: null, thumbnail: null };
        try {
          summary = await this.readSummary(e.file);
        } catch {
          // Not readable as an LFP (a .raw dump): no id, no thumbnail.
        }
        // (a virtual copy is not another import of the photo: only the masters are looked at)
        const sameName = (p) => !p.master && p.name.toLowerCase() === String(e.name).toLowerCase();
        // (the photo's id says which photo it is: a name can be shared, or changed by Rename)
        const old = replace && ((summary.photoId && this.photos.find((p) => !p.master && p.photoId === summary.photoId)) || this.photos.find(sameName));
        if (old) {
          // New files first, into staging; the old folder goes only once they are all there.
          const staging = `${STAGING}/${old.id}`;
          let copied;
          try {
            await this.store.remove(staging);
            copied = await this.copyFiles(e, old.id, summary, staging);
          } catch (err) {
            await this.store.remove(staging).catch(() => {});
            throw err;
          }
          await this.store.remove(`${PHOTOS}/${old.id}`);
          await this.store.move(staging, `${PHOTOS}/${old.id}`);
          Object.assign(old, copied, { name: e.name, size: e.file.size, photoId: summary.photoId, added: new Date().toISOString() });
          out.push(old);
          await changed();
          continue;
        }
        const existing = summary.photoId && this.photos.find((p) => !p.master && p.photoId === summary.photoId);
        if (existing) {
          if (e.sidecar && !existing.sidecar) {
            await this.store.copyIn(e.sidecar, `${PHOTOS}/${existing.id}/${e.sidecar.name}`);
            existing.sidecar = e.sidecar.name;
          }
          if ((e.depthMap && e.depthRange && !existing.depthMap) || (e.stack && !existing.stack)) {
            const dir = `${PHOTOS}/${existing.id}`;
            if (e.depthMap && e.depthRange && !existing.depthMap) Object.assign(existing, await this.copyDepth(e, dir));
            if (e.stack && !existing.stack) existing.stack = await this.copyStack(e, dir);
            await changed();
          }
          out.push(existing);
          continue;
        }
        const id = this.uniqueId(e.label || stem(e.name));
        // A folder of that name the index does not list is left over from a removed photo: its edits and caches must not pass to this one.
        await this.store.remove(`${PHOTOS}/${id}`).catch(() => {});
        const photo = { id, name: e.name, ...(await this.copyFiles(e, id, summary)), size: e.file.size, photoId: summary.photoId, added: new Date().toISOString() };
        this.photos.push(photo);
        out.push(photo);
        await changed();
      }
    } finally {
      await this.save();
    }
    onProgress(null, entries.length, entries.length);
    return out;
  }

  // Copies an entry's photo, edits and thumbnail into the folder `id`.
  async copyFiles(e, id, summary, dir = `${PHOTOS}/${id}`) {
    const file = e.file.name || e.name;
    await this.store.copyIn(e.file, `${dir}/${file}`);
    let sidecar = null;
    if (e.sidecar && e.sidecar.name.toLowerCase() !== file.toLowerCase()) {
      sidecar = e.sidecar.name;
      await this.store.copyIn(e.sidecar, `${dir}/${sidecar}`);
    }
    let thumb = null;
    try {
      if (e.thumb) {
        thumb = /\.png$/i.test(e.thumb.name) ? 'thumb.png' : 'thumb.jpg';
        await this.store.copyIn(e.thumb, `${dir}/${thumb}`);
      } else if (summary.thumbnail) {
        thumb = summary.thumbnail.mime === 'image/png' ? 'thumb.png' : 'thumb.jpg';
        await this.store.writeBlob(`${dir}/${thumb}`, new Blob([summary.thumbnail.bytes], { type: summary.thumbnail.mime }));
      }
    } catch {
      thumb = null;
    }
    return { file, sidecar, thumb, ...(await this.copyDepth(e, dir)), stack: await this.copyStack(e, dir) };
  }

  // Lytro Desktop's rendered stack (stack.lfp), for the depth it computed.
  async copyStack(e, dir) {
    if (!e.stack) return null;
    try {
      await this.store.copyIn(e.stack, `${dir}/stack.lfp`);
      return 'stack.lfp';
    } catch {
      return null;
    }
  }

  // A Lytro Desktop depth map: the image and its lambda range.
  async copyDepth(e, dir) {
    if (!e.depthMap || !e.depthRange) return { depthMap: null, depthRange: null };
    await this.store.copyIn(e.depthMap, `${dir}/${e.depthMap.name}`);
    await this.store.copyIn(e.depthRange, `${dir}/${e.depthRange.name}`);
    return { depthMap: e.depthMap.name, depthRange: e.depthRange.name };
  }

  // `options.permanent`: delete for good when the folder cannot be moved to the trash (the desktop app asks before it does).
  async remove(ids, options) {
    const gone = new Set(ids);
    // A photo's virtual copies go with it.
    for (const p of this.photos) if (p.master && gone.has(p.master)) gone.add(p.id);
    // Out of the list first, so nothing still waiting to write one of these folders (edits, caches, thumbnails) recreates it once it is gone; a folder that cannot be
    // removed (the trash question, a failure) is put back in the list, so the index and the disk keep agreeing.
    const before = this.photos;
    const albumsBefore = this.albums.map((a) => [a, a.photos]);
    this.photos = this.photos.filter((p) => !gone.has(p.id));
    for (const a of this.albums) a.photos = a.photos.filter((id) => !gone.has(id));
    try {
      for (const id of gone) await this.store.remove(`${PHOTOS}/${id}`, options);
    } catch (err) {
      const removed = new Set(gone);
      this.photos = before;
      for (const [a, list] of albumsBefore) a.photos = list;
      // (the ones removed before the failure are gone for good: list only the folders still there)
      const left = new Set((await this.store.list(PHOTOS).catch(() => [])).filter((e) => e.dir).map((e) => e.name));
      this.photos = before.filter((p) => !removed.has(p.id) || left.has(p.id));
      for (const [a, list] of albumsBefore) a.photos = list.filter((id) => this.get(id));
      await this.save().catch(() => {});
      throw err;
    }
    await this.save();
  }

  // The folder that holds a photo's light field files: its own, or for a virtual copy its master's.
  baseDir(photo) {
    return `${PHOTOS}/${photo.master || photo.id}`;
  }

  // What a virtual copy takes from its master: the names of the light field files, the thumbnail and the photo's id.
  baseFields(m) {
    const out = { file: m.file, sidecar: m.sidecar || null, thumb: m.thumb || null, size: m.size, photoId: m.photoId };
    for (const k of ['depthMap', 'depthRange', 'stack']) if (m[k]) out[k] = m[k];
    return out;
  }

  // The record the light field files are named in: the photo's own, or for a virtual copy its master's as it is now (a replaced import changes the names).
  baseOf(photo) {
    return photo.master ? this.get(photo.master) || photo : photo;
  }

  file(photo) {
    return this.store.file(`${this.baseDir(photo)}/${this.baseOf(photo).file}`);
  }

  sidecar(photo) {
    const b = this.baseOf(photo);
    return b.sidecar ? this.store.file(`${this.baseDir(photo)}/${b.sidecar}`) : Promise.resolve(null);
  }

  // { image, range } files of the photo's Lytro Desktop depth map, or null.
  async userDepth(photo) {
    const b = this.baseOf(photo);
    if (!b.depthMap || !b.depthRange) return null;
    const dir = this.baseDir(photo);
    const [image, range] = await Promise.all([this.store.file(`${dir}/${b.depthMap}`), this.store.file(`${dir}/${b.depthRange}`)]);
    return image && range ? { image, range } : null;
  }

  // The processed version Illuminator keeps next to the photo (core/processed-cache.js), as an ArrayBuffer, or null.
  async processed(photo) {
    const f = await this.store.file(`${PHOTOS}/${photo.id}/${PROCESSED_FILE}`).catch(() => null);
    return f ? f.arrayBuffer() : null;
  }

  async saveProcessed(photo, bytes) {
    if (!this.isListed(photo)) return;
    return this.store.writeBlob(`${PHOTOS}/${photo.id}/${PROCESSED_FILE}`, new Blob([bytes]));
  }

  // A full sensor render kept next to the photo (core/still-cache.js): its PNG file, or null.
  still(photo, hash) {
    return this.store.file(`${PHOTOS}/${photo.id}/${stillFileName(hash)}`).catch(() => null);
  }

  // Keeps a render; the oldest beyond the few kept are removed.
  saveStill(photo, hash, blob) {
    const dir = `${PHOTOS}/${photo.id}`;
    return this.serial(`${dir}/${STILL_INDEX_FILE}`, () => this.writeStill(photo, dir, hash, blob));
  }

  async writeStill(photo, dir, hash, blob) {
    if (!this.isListed(photo)) return;
    let index = [];
    try {
      index = JSON.parse((await this.store.readText(`${dir}/${STILL_INDEX_FILE}`)) || '[]');
    } catch {
      index = [];
    }
    await this.store.writeBlob(`${dir}/${stillFileName(hash)}`, blob);
    const next = touchIndex(index, hash);
    await this.store.writeText(`${dir}/${STILL_INDEX_FILE}`, JSON.stringify(next.index));
    for (const old of next.dropped) await this.store.remove(`${dir}/${stillFileName(old)}`);
  }

  // A full sensor picture before its color pass (core/keptpicture.js), kept next to the photo: its bytes, or null.
  async keptPicture(photo, hash) {
    const f = await this.store.file(`${PHOTOS}/${photo.id}/${keptFileName(hash)}`).catch(() => null);
    return f ? f.arrayBuffer() : null;
  }

  // Keeps one; the oldest beyond the last few are removed.
  saveKeptPicture(photo, hash, bytes) {
    const dir = `${PHOTOS}/${photo.id}`;
    return this.serial(`${dir}/${KEPT_INDEX_FILE}`, () => this.writeKept(photo, dir, hash, bytes));
  }

  async writeKept(photo, dir, hash, bytes) {
    if (!this.isListed(photo)) return;
    let index = [];
    try {
      index = JSON.parse((await this.store.readText(`${dir}/${KEPT_INDEX_FILE}`)) || '[]');
    } catch {
      index = [];
    }
    await this.store.writeBlob(`${dir}/${keptFileName(hash)}`, new Blob([bytes]));
    const next = touchIndex(index, hash, KEPT_PICTURES);
    await this.store.writeText(`${dir}/${KEPT_INDEX_FILE}`, JSON.stringify(next.index));
    for (const old of next.dropped) await this.store.remove(`${dir}/${keptFileName(old)}`);
  }

  // The photo's Lytro Desktop stack.lfp (holding the depth Lytro computed), or null.
  stack(photo) {
    const b = this.baseOf(photo);
    return b.stack ? this.store.file(`${this.baseDir(photo)}/${b.stack}`).catch(() => null) : Promise.resolve(null);
  }

  thumbnail(photo) {
    // (a virtual copy shows its master's thumbnail until one is made for it)
    const dir = photo.thumbHere ? `${PHOTOS}/${photo.id}` : this.baseDir(photo);
    const name = photo.thumbHere ? photo.thumb : this.baseOf(photo).thumb;
    return name ? this.store.file(`${dir}/${name}`) : Promise.resolve(null);
  }

  async saveThumbnail(photo, blob) {
    if (!this.isListed(photo)) return;
    const name = blob.type === 'image/png' ? 'thumb.png' : 'thumb.jpg';
    await this.store.writeBlob(`${PHOTOS}/${photo.id}/${name}`, blob);
    photo.thumb = name;
    if (photo.master) photo.thumbHere = true;
    await this.save();
  }

  async setPhotoId(photo, photoId) {
    if (!photoId || photo.photoId === photoId || !this.isListed(photo)) return;
    photo.photoId = photoId;
    await this.save();
  }

  // Ratings, flags and keywords (core/marks.js): kept on the photo's record and in an XMP sidecar next to the photo, which other programs read. Nothing set removes the sidecar.
  async setMarks(photo, marks) {
    if (!this.isListed(photo)) return;
    const m = normalizeMarks(marks);
    for (const key of ['rating', 'flag', 'keywords']) delete photo[key];
    if (m.rating) photo.rating = m.rating;
    if (m.flag) photo.flag = m.flag;
    if (m.keywords.length) photo.keywords = m.keywords;
    await this.save();
    const xmp = `${PHOTOS}/${photo.id}/${stem(photo.file)}.xmp`;
    if (hasMarks(m)) await this.store.writeText(xmp, toXmp(m));
    else await this.store.remove(xmp).catch(() => {});
  }

  // A virtual copy: another entry for the same photo, with the same light field files but settings of its own (it starts with the settings of `photo`). Its folder holds
  // only its edits, its caches and a note of whose copy it is; the files are the master's, so nothing of the photo is stored twice. A copy of a copy is a copy of the master.
  async createVirtualCopy(photo) {
    if (!this.isListed(photo)) return null;
    const master = this.get(photo.master) || photo;
    const taken = new Set(this.photos.filter((p) => p.master === master.id).map((p) => p.name.toLowerCase()));
    let name = `${master.name} copy`;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${master.name} copy ${n}`;
    const id = this.uniqueId(`${master.id}-copy`);
    const dir = `${PHOTOS}/${id}`;
    const created = new Date().toISOString();
    try {
      await this.store.writeText(`${dir}/${VIRTUAL_FILE}`, JSON.stringify({ master: master.id, name, created }));
      // The settings, and the depth already measured (it belongs to the light field, which is the same).
      const edits = await this.store.readText(`${PHOTOS}/${photo.id}/${EDITS_FILE}`).catch(() => null);
      if (edits) await this.store.writeText(`${dir}/${EDITS_FILE}`, edits);
      const processed = await this.store.file(`${PHOTOS}/${photo.id}/${PROCESSED_FILE}`).catch(() => null);
      if (processed) await this.store.writeBlob(`${dir}/${PROCESSED_FILE}`, new Blob([await processed.arrayBuffer()]));
    } catch (err) {
      await this.store.remove(dir).catch(() => {});
      throw err;
    }
    const copy = { ...this.baseFields(master), id, name, master: master.id, added: created };
    // Just after its master in the list (the list shows the newest first).
    this.photos.splice(Math.max(0, this.photos.indexOf(master)), 0, copy);
    for (const a of this.albums) if (a.photos.includes(photo.id)) a.photos.push(id);
    await this.save();
    return copy;
  }

  async loadEdits(photo) {
    try {
      const text = await this.store.readText(`${PHOTOS}/${photo.id}/${EDITS_FILE}`);
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  async saveEdits(photo, edits) {
    if (!this.isListed(photo)) return;
    return this.store.writeText(`${PHOTOS}/${photo.id}/${EDITS_FILE}`, JSON.stringify(edits, null, 2));
  }

  // ------------------------------------------------------------ looks

  look(id) {
    return this.looks.find((l) => l.id === id) || null;
  }

  // Keeps a look (core/looks.js) under a name; returns its entry.
  async addLook(name, look) {
    let n = this.looks.length + 1;
    while (this.looks.some((l) => l.id === `look-${n}`)) n++;
    const entry = { id: `look-${n}`, name: String(name).trim() || look.name || 'Look' };
    await this.store.writeText(`${LOOKS}/${entry.id}.json`, JSON.stringify({ ...look, name: entry.name }, null, 2));
    this.looks.push(entry);
    await this.save();
    return entry;
  }

  // The look's settings (the text of its file), or null.
  async loadLook(id) {
    if (!this.look(id)) return null;
    try {
      const text = await this.store.readText(`${LOOKS}/${id}.json`);
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  async renameLook(id, name) {
    const l = this.look(id);
    const clean = String(name).trim();
    if (!l || !clean) return;
    const look = await this.loadLook(id);
    l.name = clean;
    if (look) await this.store.writeText(`${LOOKS}/${id}.json`, JSON.stringify({ ...look, name: clean }, null, 2));
    await this.save();
  }

  async deleteLook(id) {
    this.looks = this.looks.filter((l) => l.id !== id);
    await this.store.remove(`${LOOKS}/${id}.json`).catch(() => {});
    await this.save();
  }

  // ------------------------------------------------------------ albums

  album(id) {
    return this.albums.find((a) => a.id === id) || null;
  }

  async createAlbum(name) {
    let n = this.albums.length + 1;
    while (this.albums.some((a) => a.id === `album-${n}`)) n++;
    const album = { id: `album-${n}`, name: String(name).trim() || 'Untitled album', photos: [] };
    this.albums.push(album);
    await this.save();
    return album;
  }

  // A photo's name in the list (the files keep theirs). Nothing is done for a blank name.
  async renamePhoto(photo, name) {
    const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!clean || !this.isListed(photo) || photo.name === clean) return false;
    photo.name = clean;
    await this.save();
    return true;
  }

  async renameAlbum(id, name) {
    const a = this.album(id);
    if (!a || !String(name).trim()) return;
    a.name = String(name).trim();
    await this.save();
  }

  async deleteAlbum(id) {
    this.albums = this.albums.filter((a) => a.id !== id);
    await this.save();
  }

  async addToAlbum(id, photoIds) {
    const a = this.album(id);
    if (!a) return;
    for (const p of photoIds) if (!a.photos.includes(p) && this.get(p)) a.photos.push(p);
    await this.save();
  }

  async removeFromAlbum(id, photoIds) {
    const a = this.album(id);
    if (!a) return;
    a.photos = a.photos.filter((p) => !photoIds.includes(p));
    await this.save();
  }

  // ------------------------------------------------------------ archives

  // An album as a zip (archive.js): its photos with their edits, Lytro
  // Desktop edits and thumbnails. onProgress(fraction).
  async exportAlbum(id, { onProgress = () => {} } = {}) {
    const album = this.album(id);
    if (!album) throw new Error('No such album');
    const asBlob = async (f) => (f instanceof Blob ? f : new Blob([await f.arrayBuffer()]));
    const files = [];
    const photos = [];
    // A virtual copy goes with its photo (its settings, not its files again): the photos of the album, each once, then their copies that are in it.
    const listed = this.list(id);
    const masters = [];
    const seen = new Set();
    for (const q of listed) {
      const m = this.baseOf(q);
      if (!seen.has(m.id)) {
        seen.add(m.id);
        masters.push(m);
      }
    }
    for (const p of masters) {
      const dir = `${PHOTOS}/${p.id}`;
      const file = await this.file(p);
      if (!file) continue;
      files.push({ path: `${dir}/${p.file}`, data: await asBlob(file) });
      const sidecar = await this.sidecar(p);
      if (sidecar) files.push({ path: `${dir}/${p.sidecar}`, data: await asBlob(sidecar) });
      const thumb = await this.thumbnail(p).catch(() => null);
      if (thumb) files.push({ path: `${dir}/${p.thumb}`, data: await asBlob(thumb) });
      const depth = await this.userDepth(p).catch(() => null);
      if (depth) {
        files.push({ path: `${dir}/${p.depthMap}`, data: await asBlob(depth.image) });
        files.push({ path: `${dir}/${p.depthRange}`, data: await asBlob(depth.range) });
      }
      const stack = await this.stack(p);
      if (stack) files.push({ path: `${dir}/${p.stack}`, data: await asBlob(stack) });
      const edits = await this.store.readText(`${dir}/${EDITS_FILE}`).catch(() => null);
      if (edits) files.push({ path: `${dir}/${EDITS_FILE}`, data: edits });
      const copies = [];
      for (const c of listed.filter((x) => x.master === p.id)) {
        const ce = await this.store.readText(`${PHOTOS}/${c.id}/${EDITS_FILE}`).catch(() => null);
        if (ce) files.push({ path: `${PHOTOS}/${c.id}/${EDITS_FILE}`, data: ce });
        copies.push({ folder: c.id, name: c.name, edits: !!ce });
      }
      photos.push({ copies, folder: p.id, rating: p.rating, flag: p.flag, keywords: p.keywords, name: p.name, file: p.file, sidecar: sidecar ? p.sidecar : null, thumb: thumb ? p.thumb : null, depthMap: depth ? p.depthMap : null, depthRange: depth ? p.depthRange : null, stack: stack ? p.stack : null, edits: !!edits });
    }
    const index = { format: ARCHIVE_FORMAT, version: ARCHIVE_VERSION, name: album.name, exported: new Date().toISOString(), photos };
    return writeZip([{ path: 'album.json', data: JSON.stringify(index, null, 2) }, ...files], { onProgress });
  }

  // Adds an exported album (a zip) to this library: its photos (one already
  // here is not copied twice), their edits (unless the photo here has some)
  // and the album, joined to one of the same name if there is one.
  // onProgress as for add(). Returns { album, photos }.
  async importAlbum(src, { onProgress = () => {} } = {}) {
    const entries = await readZip(src);
    const indexFile = entries.get('album.json');
    if (!indexFile) throw new Error('Not an Illuminator album (album.json is missing)');
    const index = JSON.parse(new TextDecoder().decode(await indexFile.arrayBuffer()));
    if (index.format !== ARCHIVE_FORMAT) throw new Error('Not an Illuminator album');
    const at = (folder, name) => (name ? entries.get(`${PHOTOS}/${folder}/${name}`) || null : null);
    const items = (index.photos || [])
      .map((p) => ({ meta: p, entry: { name: p.name, label: p.folder, file: at(p.folder, p.file), sidecar: at(p.folder, p.sidecar), thumb: at(p.folder, p.thumb), depthMap: at(p.folder, p.depthMap), depthRange: at(p.folder, p.depthRange), stack: at(p.folder, p.stack) } }))
      .filter((i) => i.entry.file);
    const photos = await this.add(items.map((i) => i.entry), { onProgress });
    for (let i = 0; i < photos.length; i++) {
      const edits = items[i].meta.edits ? at(items[i].meta.folder, EDITS_FILE) : null;
      if (!edits || (await this.loadEdits(photos[i]))) continue;
      await this.store.writeText(`${PHOTOS}/${photos[i].id}/${EDITS_FILE}`, new TextDecoder().decode(await edits.arrayBuffer()));
    }
    // Its virtual copies: made again with the settings they had (one with that name already here is left as it is).
    const copyIds = [];
    for (let i = 0; i < photos.length; i++) {
      for (const c of items[i].meta.copies || []) {
        const have = this.photos.find((p) => p.master === photos[i].id && p.name === c.name);
        if (have) {
          copyIds.push(have.id);
          continue;
        }
        const copy = await this.createVirtualCopy(photos[i]);
        if (!copy) continue;
        copy.name = String(c.name || copy.name);
        const dir = `${PHOTOS}/${copy.id}`;
        const e = c.edits ? at(c.folder, EDITS_FILE) : null;
        if (e) await this.store.writeText(`${dir}/${EDITS_FILE}`, new TextDecoder().decode(await e.arrayBuffer()));
        else await this.store.remove(`${dir}/${EDITS_FILE}`).catch(() => {});
        copyIds.push(copy.id);
      }
    }
    await this.save();
    // The marks the photos had (a photo already here keeps its own).
    for (let i = 0; i < photos.length; i++) {
      const meta = items[i].meta;
      if ((meta.rating || meta.flag || (meta.keywords && meta.keywords.length)) && !(photos[i].rating || photos[i].flag || photos[i].keywords)) {
        await this.setMarks(photos[i], { rating: meta.rating, flag: meta.flag, keywords: meta.keywords });
      }
    }
    const name = String(index.name || 'Imported album');
    const album = this.albums.find((a) => a.name === name) || (await this.createAlbum(name));
    await this.addToAlbum(album.id, [...photos.map((p) => p.id), ...copyIds]);
    return { album, photos };
  }

  // Photos in an album (or all photos when id is null), newest first.
  list(albumId = null) {
    const a = albumId ? this.album(albumId) : null;
    const photos = a ? a.photos.map((id) => this.get(id)).filter(Boolean) : [...this.photos].reverse();
    return photos;
  }
}
