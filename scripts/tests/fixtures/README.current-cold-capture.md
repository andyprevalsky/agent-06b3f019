current-cold-capture-6189.py.gz is the exact source-only capture producer from
commit6189d6e6cdbcc82d7715809daef25158e6834534, compressed with gzip mtime0.
Uncompressed SHA256:
852abb705880ada9f5b6d931dd4285de3f49e2003e2ba5d479dab0e920d6b6c9

It contains repository Python source, not a live packet, credentials or guest
data. CurrentColdImportedNativeTests uses it to create a sanitized historical
capsule through the real capture/commit/export pipeline before verifying it
with the current importer. Keep its bytes unchanged: changing the verifier must
not silently recapture or rewrite previously sealed source evidence.
