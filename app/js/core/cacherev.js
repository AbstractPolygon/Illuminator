// The revision of what the saved caches next to a photo hold (the measured depth, the lens centers, what opening a photo works out; see worker.js depthCacheKey and the
// processed version in core/processed-cache.js). A cache saved with another revision is not used and is made again, so this changes only when the code that measures those
// things changes what it measures, and not with every release: a new version of the app finds the caches of the last one. test/cacherev.test.mjs fails when one of those
// files changed and the revision (and the checksum there) has not been looked at.
export const CACHE_REV = 3;
