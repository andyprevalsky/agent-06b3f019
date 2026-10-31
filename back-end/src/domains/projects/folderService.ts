/**
 * Client -> authenticated project routes -> folder service -> repo -> ProjectFolder.
 * Project 1--* ProjectFolder; ProjectFolder 1--* Agent (nullable FK).
 * Folder deletion SET NULL keeps the project; project deletion cascades folders
 * and SET NULL returns agents Home. No folder parent/nesting exists.
 * Indexed project/UUID lookups; folder writes lock only their owning project.
 */
import * as repo from './repo';
import { ProjectError, requireProject } from './service';

export async function listFolders(userId: string, projectId: string) {
  await requireProject(userId, projectId);
  return { folders: await repo.listFolders(projectId) };
}

async function writeFolder<T>(write: () => Promise<T>): Promise<T> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof repo.FolderProjectMissingError) {
      throw new ProjectError(404, 'Project not found');
    }
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
  return writeFolder(async () => {
    const result = await repo.renameFolder(projectId, id, name);
    if (result === null) throw new ProjectError(404, 'Folder not found');
    return result;
  });
}

export async function deleteFolder(userId: string, projectId: string, id: string) {
  await requireProject(userId, projectId);
  const result = await writeFolder(() => repo.deleteFolder(projectId, id));
  if (result.count === 0) throw new ProjectError(404, 'Folder not found');
}

export async function reorderFolders(userId: string, projectId: string, folderIds: string[]) {
  await requireProject(userId, projectId);
  const folders = await writeFolder(() => repo.reorderFolders(projectId, folderIds));
  if (folders === null) {
    throw new ProjectError(
      409,
      'Folder membership changed; reload folders and retry',
      'folder_order_stale'
    );
  }
  return { folders };
}
