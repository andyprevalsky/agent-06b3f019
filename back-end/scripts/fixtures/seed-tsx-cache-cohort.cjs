// Child-only filesystem seam: a large expired cache without creating 60,000
// physical files on every test run. Exercise the real resolved TSX loader;
// defer each deletion as real asynchronous filesystem work would be deferred.
// Only this child's private TMPDIR cache is intercepted; shared caches are untouched.
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(
  require('node:os').tmpdir(),
  `tsx-${process.geteuid ? process.geteuid() : require('node:os').userInfo().username}`
);
const names = Array.from({ length: 60000 }, (_, i) => `0-${i.toString(16).padStart(40, '0')}`);
let enumerated = 0;
const read = fs.readdirSync;
fs.readdirSync = function (dir, ...args) {
  if (String(dir) !== root) return read.call(this, dir, ...args);
  enumerated += names.length;
  return names.slice();
};
const open = fs.promises.opendir;
fs.promises.opendir = async function (dir, ...args) {
  if (String(dir) !== root) return open.call(this, dir, ...args);
  return {
    async *[Symbol.asyncIterator]() {
      for (const name of names) {
        enumerated += 1;
        yield { name };
      }
    },
  };
};
const unlink = fs.promises.unlink;
fs.promises.unlink = async function (file, ...args) {
  if (path.dirname(String(file)) !== root) return unlink.call(this, file, ...args);
  await new Promise((resolve) => setImmediate(resolve));
};
process.on('exit', () => {
  console.log('CACHE_PROBE_ENUMERATED=' + enumerated);
  console.log('CACHE_PROBE_RSS_KB=' + process.resourceUsage().maxRSS);
});
