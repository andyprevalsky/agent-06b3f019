export class TasksUnavailableError extends Error {
  constructor() {
    super('Benchmark tasks unavailable');
  }
}
