import AdmZip from 'adm-zip';
import {
  uploadFileToIntegrations,
  ctx,
  assertStatus,
  assert,
  prisma,
  request,
  BASE_URL,
  authHeaders,
  uniqueName,
} from './integrations.context';

// --- Apple passwords CSV upload: exercises parseApplePasswordsCsv, encryptPasswordForStorage, bulk upsert ---

export async function testApplePasswordsUpload_validCsv() {
  const csvContent = [
    'Title,URL,Username,Password,Notes,OTPAuth',
    'Example,https://example.com,user1,pass123,some notes,',
    'Google,https://accounts.google.com,user2,securepass,,',
    'GitHub,https://github.com,user3,gh_token,dev account,',
  ].join('\n');
  const res = await uploadFileToIntegrations(
    '/passwords/apple/upload',
    ctx.accessToken1!,
    'passwords.csv',
    csvContent,
    'text/csv'
  );
  assertStatus(res.status, 200, res.data);
  const body = res.data as { message: string; passwordCount: number };
  assert(body.passwordCount === 3, `Expected 3 passwords, got ${body.passwordCount}`);

  const appleIntegration = await prisma.integration.findUnique({
    where: {
      userId_name_accountId: { userId: ctx.userId1!, name: 'apple_passwords', accountId: '' },
    },
  });
  assert(appleIntegration !== null, 'Expected apple_passwords integration to be created');
  assert(
    appleIntegration.status === 'CONNECTED',
    `Expected CONNECTED, got ${appleIntegration.status}`
  );
  assert(appleIntegration.isActive === true, 'Expected apple_passwords integration to be active');
  assert(appleIntegration.lastSyncAt !== null, 'Expected lastSyncAt to be set');
  assert(appleIntegration.lastSuccessfulSyncAt !== null, 'Expected lastSuccessfulSyncAt to be set');
}

export async function testApplePasswordsUpload_tabDelimited() {
  const csvContent = [
    'Title\tURL\tUsername\tPassword\tNotes\tOTPAuth',
    'Tab Test\thttps://tab.example.com\ttabuser\ttabpass\t\t',
  ].join('\n');
  const res = await uploadFileToIntegrations(
    '/passwords/apple/upload',
    ctx.accessToken1!,
    'passwords.csv',
    csvContent,
    'text/csv'
  );
  assertStatus(res.status, 200, res.data);
  const body = res.data as { message: string; passwordCount: number };
  assert(body.passwordCount === 1, `Expected 1 password, got ${body.passwordCount}`);
}

export async function testApplePasswordsUpload_noValidPasswords() {
  const csvContent = [
    'Title,URL,Username,Password,Notes,OTPAuth',
    ',,,,,', // all empty
    ',,,,,',
  ].join('\n');
  const res = await uploadFileToIntegrations(
    '/passwords/apple/upload',
    ctx.accessToken1!,
    'passwords.csv',
    csvContent,
    'text/csv'
  );
  assertStatus(res.status, 400, res.data);
}

export async function testApplePasswordsUpload_headerOnly() {
  const csvContent = 'Title,URL,Username,Password,Notes,OTPAuth';
  const res = await uploadFileToIntegrations(
    '/passwords/apple/upload',
    ctx.accessToken1!,
    'passwords.csv',
    csvContent,
    'text/csv'
  );
  assertStatus(res.status, 400, res.data);
}

export async function testApplePasswordsUpload_missingColumns() {
  const csvContent = ['Name,Email', 'test,test@test.com'].join('\n');
  const res = await uploadFileToIntegrations(
    '/passwords/apple/upload',
    ctx.accessToken1!,
    'passwords.csv',
    csvContent,
    'text/csv'
  );
  assertStatus(res.status, 400, res.data);
}

export async function testApplePasswordsUpload_quotedFields() {
  const csvContent = [
    'Title,URL,Username,Password,Notes,OTPAuth',
    '"My ""App""","https://app.example.com","user,name","pass""word","note with, comma",',
  ].join('\n');
  const res = await uploadFileToIntegrations(
    '/passwords/apple/upload',
    ctx.accessToken1!,
    'passwords.csv',
    csvContent,
    'text/csv'
  );
  assertStatus(res.status, 200, res.data);
  const body = res.data as { message: string; passwordCount: number };
  assert(body.passwordCount === 1, `Expected 1 password, got ${body.passwordCount}`);
}

export async function testApplePasswordsUpload_duplicateOriginUsername() {
  const csvContent = [
    'Title,URL,Username,Password,Notes,OTPAuth',
    'Dup1,https://dup.example.com,sameuser,pass1,,',
    'Dup2,https://dup.example.com,sameuser,pass2,,',
    'Other,https://other.example.com,otheruser,pass3,,',
  ].join('\n');
  const res = await uploadFileToIntegrations(
    '/passwords/apple/upload',
    ctx.accessToken1!,
    'passwords.csv',
    csvContent,
    'text/csv'
  );
  assertStatus(res.status, 200, res.data);
  const body = res.data as { message: string; passwordCount: number };
  // 2 unique origin+username combinations after dedup
  assert(body.passwordCount === 2, `Expected 2 passwords after dedup, got ${body.passwordCount}`);
}

// --- Generic file upload: exercises processGenericUpload ---

export async function testGenericUpload_withFile() {
  const res = await uploadFileToIntegrations(
    '/upload',
    ctx.accessToken1!,
    'test-data.txt',
    'some test content for generic upload',
    'text/plain',
    { integrationType: 'test_data' }
  );
  assertStatus(res.status, 200, res.data);
  const body = res.data as { message: string; integration: unknown };
  assert(
    body.message.includes('uploaded'),
    `Expected upload success message, got: ${body.message}`
  );
}

export async function testGenericUpload_missingIntegrationType() {
  const res = await uploadFileToIntegrations(
    '/upload',
    ctx.accessToken1!,
    'test-data.txt',
    'some test content',
    'text/plain'
  );
  assertStatus(res.status, 400, res.data);
}

// --- LinkedIn upload: non-zip file validation ---

export async function testLinkedinUpload_nonZipFile() {
  const res = await uploadFileToIntegrations(
    '/linkedin/upload',
    ctx.accessToken1!,
    'data.txt',
    'not a zip file',
    'text/plain'
  );
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  assert(body.error.includes('.zip'), `Expected zip error message, got: ${body.error}`);
}

// --- LinkedIn upload: first installment of the export (no Connections.csv) ---

/**
 * LinkedIn's first installment (Profile, Registration, ... but no Connections.csv)
 * arrives minutes after the request. Importing it used to reply "imported
 * successfully" with 0 contacts and mark LinkedIn connected, so the export agent
 * stopped before the archive with connections was ready. It is refused, without
 * touching the integration, and the reply says where the full archive comes from.
 */
export async function testLinkedinUpload_firstInstallmentWithoutConnections_422() {
  const zip = new AdmZip();
  zip.addFile('Profile.csv', Buffer.from('First Name,Last Name,Headline\nAda,Owner,Engineer\n'));
  zip.addFile('Registration.csv', Buffer.from('Registered At\n1/1/20, 9:00 AM\n'));
  const before = await prisma.integration.findFirst({
    where: { userId: ctx.userId1!, name: 'linkedin' },
    select: { status: true, updatedAt: true },
  });
  const form = new FormData();
  form.append(
    'file',
    new Blob([new Uint8Array(zip.toBuffer())], { type: 'application/zip' }),
    'Basic_LinkedInDataExport_10-28-2026.zip.zip'
  );
  const response = await fetch(`${BASE_URL}/api/integrations/linkedin/upload`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${ctx.accessToken1!}` },
    body: form,
  });
  const body = (await response.json()) as { error?: string };
  assertStatus(response.status, 422, body);
  assert(
    body.error?.includes('Connections.csv') === true && body.error.includes('first installment'),
    `Expected the first-installment explanation, got: ${body.error}`
  );
  const after = await prisma.integration.findFirst({
    where: { userId: ctx.userId1!, name: 'linkedin' },
    select: { status: true, updatedAt: true },
  });
  assert(
    JSON.stringify(after) === JSON.stringify(before),
    `A refused archive must not write the integration: ${JSON.stringify({ before, after })}`
  );
}

// --- Contacts upload: non-vcf file validation ---

export async function testContactsUpload_nonVcfFile() {
  const res = await uploadFileToIntegrations(
    '/contacts/upload',
    ctx.accessToken1!,
    'contacts.txt',
    'not a vcf file',
    'text/plain'
  );
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  assert(body.error.includes('.vcf'), `Expected vcf error message, got: ${body.error}`);
}

// --- Email archive upload: non-zip file validation ---

export async function testEmailArchiveUpload_nonZipFile() {
  const res = await uploadFileToIntegrations(
    '/email/upload',
    ctx.accessToken1!,
    'emails.txt',
    'not a zip file',
    'text/plain'
  );
  assertStatus(res.status, 400, res.data);
  const body = res.data as { error: string };
  assert(body.error.includes('.zip'), `Expected zip error message, got: ${body.error}`);
}

// --- Passwords request happy path (exercises sendPasswordRequest -> sendSms) ---

export async function testPasswordsRequest_happyPath() {
  const res = await request(`${BASE_URL}/api/integrations/passwords/request`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ request: 'I need password integration for 1Password please' }),
  });
  // 200 if SMS sent successfully, 500 if SMS config not available in test env
  if (res.status !== 200 && res.status !== 500) {
    throw new Error(`Expected 200 or 500, got ${res.status}`);
  }
}

// --- Integration CRUD edge cases ---

export async function testPatch_withStatusChange() {
  const name = uniqueName('patch-status');
  // Create integration first
  const createRes = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE' }),
  });
  assertStatus(createRes.status, 200, createRes.data);

  // Patch with specific status
  const patchRes = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ status: 'SYNCING' }),
  });
  assertStatus(patchRes.status, 200, patchRes.data);
  const patched = (patchRes.data as { integration: { status: string } }).integration;
  assert(patched.status === 'SYNCING', `Expected SYNCING, got ${patched.status}`);
}

export async function testPatch_withInvalidStatus() {
  const name = uniqueName('patch-badstatus');
  const createRes = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE' }),
  });
  assertStatus(createRes.status, 200, createRes.data);

  const patchRes = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ status: 'INVALID_STATUS' }),
  });
  // Should return error for invalid status
  if (patchRes.status !== 400 && patchRes.status !== 500) {
    throw new Error(`Expected 400 or 500 for invalid status, got ${patchRes.status}`);
  }
}

export async function testPatch_withConfigUpdate() {
  const name = uniqueName('patch-config');
  const createRes = await request(`${BASE_URL}/api/integrations`, {
    method: 'POST',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ name, type: 'DATA_SOURCE' }),
  });
  assertStatus(createRes.status, 200, createRes.data);

  const patchRes = await request(`${BASE_URL}/api/integrations/${name}`, {
    method: 'PATCH',
    headers: authHeaders(ctx.accessToken1!),
    body: JSON.stringify({ config: { customKey: 'customValue', nested: { a: 1 } } }),
  });
  assertStatus(patchRes.status, 200, patchRes.data);
}
