const rawPublicManifest = process.env.TRACE_ARCHIVE_PUBLIC_MANIFEST;
export const TRACE_ARCHIVE_PUBLIC_MANIFEST =
  (rawPublicManifest !== undefined && rawPublicManifest !== ''
    ? rawPublicManifest
    : 'true'
  ).toLowerCase() !== 'false';
const rawBaseImageHash = process.env.TRACE_ARCHIVE_BASE_IMAGE_HASH;
export const TRACE_ARCHIVE_BASE_IMAGE_HASH =
  rawBaseImageHash !== undefined && rawBaseImageHash !== '' ? rawBaseImageHash : null;
