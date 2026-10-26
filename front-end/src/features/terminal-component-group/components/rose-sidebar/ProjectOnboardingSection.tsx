import { useState } from 'react';
import type { Project } from '@/lib/api/projects';
import { downloadProjectSetupHelper } from '@/lib/api/projectOnboarding';
import { useProjectEnvFiles } from './useProjects';

export function ProjectOnboardingSection({ project }: { project: Project }) {
  const files = useProjectEnvFiles(project.id);
  const [state, setState] = useState<'idle' | 'downloading' | 'downloaded' | 'failed'>('idle');
  const missing = files.data?.filter((file) => !file.hasContent) ?? [];
  const download = async () => {
    setState('downloading');
    try {
      await downloadProjectSetupHelper(project.id);
      setState('downloaded');
    } catch {
      setState('failed');
    }
  };
  return (
    <section aria-label="Development environment" className="mt-5 space-y-2 text-sm">
      <h3 className="font-semibold">Development environment</h3>
      <p>Import your working checkout, including environment files, keys, and dependency setup.</p>
      {files.isError && (
        <p role="alert">Could not check environment files. Try reopening settings.</p>
      )}
      {missing.length > 0 && (
        <p role="status">Missing required files: {missing.map((file) => file.path).join(', ')}</p>
      )}
      {project.sync.lastSyncedAt === null ? (
        <p>Not imported yet.</p>
      ) : (
        <p>Checkout imported. Verify workspace startup before using it.</p>
      )}
      <button
        type="button"
        disabled={state === 'downloading'}
        onClick={() => void download()}
        className="font-semibold disabled:opacity-40"
      >
        {state === 'downloading' ? 'Downloading…' : 'Download setup helper'}
      </button>
      {state === 'downloaded' && (
        <p>
          Unzip the helper and follow README.txt from your working repository. Keys stay encrypted
          in transit and storage.
        </p>
      )}
      {state === 'failed' && <p role="alert">Could not download the setup helper. Try again.</p>}
    </section>
  );
}
