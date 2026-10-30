/**
 * Client -> authenticated project routes -> folder service -> repo -> ProjectFolder.
 * Project 1--* ProjectFolder; ProjectFolder 1--* Agent (nullable FK).
 * Folder deletion SET NULL keeps the project; project deletion cascades folders
 * and SET NULL returns agents Home. No folder parent/nesting exists.
 * Indexed project/UUID lookups; no per-agent polling or shared hot-path lock.
 */
import * as repo from './repo';
import { ProjectError, requireProject } from './service';

export async function listFolders(userId: string, projectId: string) {
  await requireProject(userId, projectId);
  return { folders: await repo.listFolders(projectId) };
}

async function writeFolder(write: () => Promise<unknown>) {
  try {
    return await write();
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002') {
      throw new ProjectError(409, 'A folder with this name exists');
    }
    throw error;
  }
}

export async function createFolder(userId: string, projectId: string, name: string) {
  await requireProject(userId, projectId);
  return writeFolder(() => repo.createFolder(projectId, name));
}

export async function renameFolder(userId: string, projectId: string, id: string, name: string) {
  await requireProject(userId, projectId);
  await writeFolder(async () => {
    const result = await repo.renameFolder(projectId, id, name);
    if (result.count === 0) throw new ProjectError(404, 'Folder not found');
  });
  return { id, name, projectId };
}

export async function deleteFolder(userId: string, projectId: string, id: string) {
  await requireProject(userId, projectId);
  const result = await repo.deleteFolder(projectId, id);
  if (result.count === 0) throw new ProjectError(404, 'Folder not found');
}
