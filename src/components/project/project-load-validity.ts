export function canCommitProjectLoad(
  generation: number,
  currentGeneration: number,
  projectId: string,
  pendingProjectId: string | null,
  isCurrent: () => boolean = () => true,
): boolean {
  return (
    generation === currentGeneration &&
    projectId === pendingProjectId &&
    isCurrent()
  )
}
