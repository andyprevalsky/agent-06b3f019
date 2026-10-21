import { API_BASE_WITH_PATH, getAuthHeaders } from './client';

export async function downloadProjectSetupHelper(projectId: string): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId))
    throw new Error('Invalid project');
  const response = await fetch(`${API_BASE_WITH_PATH}/projects/sync-client`, {
    headers: getAuthHeaders(),
  });
  if (!response.ok) throw new Error('Could not download setup helper');
  const data = await response.json();
  const expected = new Set([
    'rose-sync',
    'lib/rose-sync/cli.mjs',
    'lib/rose-sync/capture.mjs',
    'lib/rose-sync/onboarding.mjs',
  ]);
  if (
    !Array.isArray(data.files) ||
    data.files.length !== expected.size ||
    data.files.some(
      (file: { path?: unknown; content?: unknown }) =>
        typeof file.path !== 'string' ||
        !expected.delete(file.path) ||
        typeof file.content !== 'string',
    )
  )
    throw new Error('Invalid setup helper');
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  for (const file of data.files) zip.file(`rose-setup/${file.path}`, file.content);
  zip.file(
    'rose-setup/README.txt',
    `From your working repository, run:\nnode /path/to/rose-setup/rose-sync onboard --project ${projectId} --dir .\n\nAuthenticate with your personal ROSE_API_KEY or ROSE_TOKEN environment variable. Never commit these credentials.\nThe helper encrypts real environment files before upload, preserves linked files, and configures dependency setup. Missing declared files block onboarding. Workspace startup must then be verified separately.\n`,
  );
  const url = URL.createObjectURL(await zip.generateAsync({ type: 'blob' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'rose-setup.zip';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
