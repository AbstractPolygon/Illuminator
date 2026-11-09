// Typed array helpers for the hot paths. Float32Array.from(source, fn) goes through the iterator protocol and is about thirty times slower than a plain loop, so a map of a
// whole picture or depth map is written with mapF32 instead (the same values; fn gets the element and its index).
export function mapF32(source, fn) {
  const out = new Float32Array(source.length);
  for (let i = 0; i < out.length; i++) out[i] = fn(source[i], i);
  return out;
}

// The k-th smallest value of `values` (what Float32Array.from(values).sort()[k] gives, without sorting all of them): quickselect on a copy. NaNs sort last, as in a sort.
export function nthSmallest(values, k) {
  const a = Float32Array.from(values);
  let nan = 0;
  for (let i = a.length - 1; i >= 0; i--) {
    if (a[i] !== a[i]) {
      a[i] = a[a.length - 1 - nan];
      a[a.length - 1 - nan] = NaN;
      nan++;
    }
  }
  const n = a.length - nan;
  if (k >= n) return NaN;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const pivot = a[(lo + hi) >> 1];
    let i = lo;
    let j = hi;
    while (i <= j) {
      while (a[i] < pivot) i++;
      while (a[j] > pivot) j--;
      if (i <= j) {
        const tmp = a[i];
        a[i] = a[j];
        a[j] = tmp;
        i++;
        j--;
      }
    }
    if (k <= j) hi = j;
    else if (k >= i) lo = i;
    else return a[k];
  }
  return a[k];
}
