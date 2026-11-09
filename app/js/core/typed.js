// Typed array helpers for the hot paths. Float32Array.from(source, fn) goes through the iterator protocol and is about thirty times slower than a plain loop, so a map of a
// whole picture or depth map is written with mapF32 instead (the same values; fn gets the element and its index).
export function mapF32(source, fn) {
  const out = new Float32Array(source.length);
  for (let i = 0; i < out.length; i++) out[i] = fn(source[i], i);
  return out;
}

// A copy of `values` with the NaNs moved to the end (they sort last, as in a sort), and how many values are not NaN.
function withNaNLast(values) {
  const a = new Float32Array(values);
  let nan = 0;
  for (let i = a.length - 1; i >= 0; i--) {
    if (a[i] !== a[i]) {
      a[i] = a[a.length - 1 - nan];
      a[a.length - 1 - nan] = NaN;
      nan++;
    }
  }
  return { a, n: a.length - nan };
}

// Quickselect: puts the k-th smallest of a[lo..hi] at a[k], everything before it no larger and everything after it no smaller, and returns it.
function select(a, k, lo, hi) {
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

// The k-th smallest value of `values` (what Float32Array.from(values).sort()[k] gives, without sorting all of them): quickselect on a copy. NaNs sort last, as in a sort.
export function nthSmallest(values, k) {
  const { a, n } = withNaNLast(values);
  return k >= n ? NaN : select(a, k, 0, n - 1);
}

// Two of them, k1 <= k2, from one copy: [the k1-th, the k2-th] smallest (the percentiles at the two ends of a range).
export function nthSmallestPair(values, k1, k2) {
  const { a, n } = withNaNLast(values);
  const first = k1 >= n ? NaN : select(a, k1, 0, n - 1);
  // (after the first selection everything past k1 is no smaller than it, so the second one looks only there)
  const second = k2 >= n ? NaN : k2 === k1 ? first : select(a, k2, k1 + 1, n - 1);
  return [first, second];
}
