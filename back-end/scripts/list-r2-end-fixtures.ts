/**
 * List root agent ids that have db/end.fixture.json.gz.enc in R2.
 * Writes /tmp/r2-end-fixture-ids.json
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';

const ARCHIVE_PREFIX = ['trace', 'archive'].join('-') + '/';

async function main(): Promise<void> {
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID || ''}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    },
  });
  const bucket = process.env.R2_BUCKET_TRACE_ARCHIVE || '';
  const endFixtureIds: string[] = [];
  let token: string | undefined;
  let scanned = 0;
  let pages = 0;
  do {
    const resp = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: ARCHIVE_PREFIX,
        ContinuationToken: token,
        MaxKeys: 1000,
      })
    );
    pages += 1;
    for (const obj of resp.Contents ?? []) {
      scanned += 1;
      const key = obj.Key || '';
      if (!key.endsWith('/db/end.fixture.json.gz.enc')) continue;
      const id = key.slice(ARCHIVE_PREFIX.length).split('/')[0];
      if (id) endFixtureIds.push(id);
    }
    if (pages % 20 === 0) {
      console.error(`pages=${pages} scanned=${scanned} endFixtures=${endFixtureIds.length}`);
    }
    token = resp.NextContinuationToken;
  } while (token !== undefined);

  writeFileSync('/tmp/r2-end-fixture-ids.json', JSON.stringify(endFixtureIds));
  console.log(
    JSON.stringify(
      {
        scannedObjects: scanned,
        pages,
        endFixtures: endFixtureIds.length,
        sample: endFixtureIds.slice(0, 10),
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
