/**
 * Folders: the user-facing name of a Project row with isFolder, organizational only.
 *
 *   folder (this API)   = Project row with isFolder (same id: legacy_project_id === id)
 *   subfolder           = ProjectFolder (one level, unchanged)
 *   folder's GitHub repo → read-only summary of the "github_repo" integration;
 *                          connecting one happens on the integrations panel
 *
 * Nothing is migrated or copied: /api/projects, Agent.projectId/folderId and
 * every project setting keep working, so this is a pure alias layer. Creating
 * a folder never sets a repository. Repositories that are not folders (GitHub
 * connect, CLI import) are not listed; deleting a folder that is also a
 * repository keeps the repository (service.deleteFolderProject).
 */
import * as service from './service';

export interface TopFolderDto {
  id: string;
  name: string;
  /** Same row under the legacy /api/projects API. */
  legacy_project_id: string;
  subfolders: { id: string; name: string }[];
  /** Connected repo the folder's code sessions restore (integration ref); null: none. */
  github_repo: { canonical_ref: string; repo_url: string } | null;
  created_at: string;
  updated_at: string;
}

export function toTopFolderDto(project: service.ProjectDto): TopFolderDto {
  return {
    id: project.id,
    name: project.name,
    legacy_project_id: project.id,
    subfolders: project.folders.map((folder) => ({ id: folder.id, name: folder.name })),
    github_repo:
      project.github_repo_ref !== null && project.repoUrl !== null
        ? { canonical_ref: project.github_repo_ref, repo_url: project.repoUrl }
        : null,
    created_at: project.createdAt,
    updated_at: project.updatedAt,
  };
}

export async function listTopFolders(userId: string): Promise<{ folders: TopFolderDto[] }> {
  const { projects } = await service.listFolderProjects(userId);
  return { folders: projects.map(toTopFolderDto) };
}

export async function getTopFolder(userId: string, id: string): Promise<TopFolderDto> {
  return toTopFolderDto(await service.getProject(userId, id));
}

/** A new folder is a repo-less project: name only. */
export async function createTopFolder(userId: string, name: string): Promise<TopFolderDto> {
  return toTopFolderDto(await service.createProject(userId, { name }, { isFolder: true }));
}

export async function renameTopFolder(
  userId: string,
  id: string,
  name: string
): Promise<TopFolderDto> {
  return toTopFolderDto(await service.updateProject(userId, id, { name }));
}

export async function deleteTopFolder(userId: string, id: string): Promise<void> {
  await service.deleteFolderProject(userId, id);
}
