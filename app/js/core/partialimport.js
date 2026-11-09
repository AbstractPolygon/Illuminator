// A camera import that stopped part way: the desktop app's error carries `imported` (the photos already copied into the library's staging folder) and
// `failedFile` (the camera file that could not be read). The page adds the copied photos to the library anyway, so nothing is left behind in the staging folder.
// Returns { files, message }: files are { path, name, size } entries (a bare path string is accepted and named from its path); empty when nothing was copied.
const baseName = (p) => String(p).split(/[\\/]/).pop();

export function partialImport(err) {
  const raw = err && (Array.isArray(err.imported) ? err.imported : err.cause && Array.isArray(err.cause.imported) ? err.cause.imported : null);
  const files = (raw || [])
    .map((f) => (typeof f === 'string' ? { path: f, name: baseName(f), size: undefined } : f))
    .filter((f) => f && f.path);
  if (!files.length) return { files: [], message: '' };
  const n = files.length;
  const failed = err.failedFile ? String(err.failedFile) : '';
  const copied = `${n === 1 ? '1 photo was' : `${n} photos were`} copied`;
  return { files, message: `${copied}; ${failed || 'one photo'} could not be read from the camera.` };
}
